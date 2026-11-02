/**
 * `VoiceModelManager` (ADR-004 D5) : installe, vérifie, met à jour et supprime
 * les modèles de voix dans `<userData>/models/voice/<id>@<version>/`.
 *
 * Installation atomique, dans cet ordre :
 *  1. vérification de la place disque ;
 *  2. téléchargement dans un `.partial`, avec reprise (`Range`) ;
 *  3. contrôle du SHA-256 du catalogue ;
 *  4. extraction par `tar`, appelé sans shell, dans un dossier temporaire ;
 *  5. contrôle de la liste exacte des fichiers, aucun chemin hors du dossier ;
 *  6. renommage final, puis écriture de `manifest.json`.
 *
 * Un modèle n'est « installé » que si son dossier final a un `manifest.json`
 * conforme au catalogue : après un crash à n'importe quelle étape, il n'y a donc
 * rien d'installé à moitié, et {@link VoiceModelManager.init} nettoie les restes.
 *
 * Aucun état global : chaque I/O externe (réseau, place disque, `tar`, horloge)
 * est injectée. Les téléchargements ont lieu dans le main, jamais dans le
 * process de reconnaissance (ADR-004 §7).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AtelierError, checkServerUrl, isAtelierError } from '@atelier/shared';
import type { SerializedAtelierError, VoiceModelInfo } from '@atelier/shared';
import {
  VOICE_MODEL_CATALOG,
  entryDiskBytes,
  modelDirName,
  toModelInfo,
  type DownloadedVoiceModelSource,
  type VoiceCatalogEntry,
  type VoiceModelFile,
} from './catalog.js';
import {
  checkArchiveEntries,
  checkExtractedTree,
  systemTar,
  tarExtractArgs,
  tarListArgs,
  type TarRunner,
} from './archive.js';

/** Étapes d'une installation (progression, simulation de crash dans les tests). */
export type VoiceInstallStep =
  'disk' | 'download' | 'verify' | 'extract' | 'check' | 'commit' | 'manifest' | 'cleanup';

/** Origine d'un modèle installé. */
export type VoiceModelOrigin = 'official' | 'mirror' | 'import';

/** Contenu de `manifest.json`, écrit en dernier. */
export interface VoiceModelManifest {
  id: string;
  version: string;
  sha256: string;
  origin: VoiceModelOrigin;
  /** ISO 8601. */
  installedAt: string;
  files: VoiceModelFile[];
}

/** Version installée qui n'est plus celle du catalogue de l'app. */
export interface VoiceModelUpdate {
  id: string;
  installedVersion: string;
  catalogVersion: string;
}

/** Fichiers d'un modèle prêt à charger. */
export interface ResolvedVoiceModel {
  id: string;
  version: string;
  /** Dossier du modèle (téléchargé) ou dossier des modèles embarqués. */
  dir: string;
  /** Chemin absolu de chaque fichier, par chemin relatif du catalogue. */
  files: Record<string, string>;
}

/** Dépendances et réglages du gestionnaire. */
export interface VoiceModelManagerOptions {
  /** `<userData>/models/voice` (voir {@link voiceModelsDir}). */
  rootDir: string;
  /** Dossier des modèles embarqués (`Contents/Resources/voice`). */
  bundledDir: string;
  catalog?: readonly VoiceCatalogEntry[];
  /** Réseau (main), injecté. */
  fetch?: typeof fetch;
  /** Octets libres sur le volume de `path`. */
  freeBytes?: (path: string) => Promise<number>;
  tar?: TarRunner;
  now?: () => number;
  /** Changement d'état d'un modèle (événement `voice:model`). */
  onModelChange?: (info: VoiceModelInfo) => void;
  /** Appelé avant chaque étape ; une exception y simule un crash (tests). */
  onStep?: (id: string, step: VoiceInstallStep) => void | Promise<void>;
  /** Intervalle minimal entre deux événements de progression. */
  progressIntervalMs?: number;
  /** Marge de place disque gardée en plus du besoin. */
  diskMarginBytes?: number;
}

/** Options d'une installation par le réseau. */
export interface InstallOptions {
  /** Miroir (`voice.modelSourceUrl`) ; absent : source officielle. */
  sourceUrl?: string;
  signal?: AbortSignal;
}

/** Dossier des modèles de voix sous les données de l'app. */
export function voiceModelsDir(userDataDir: string): string {
  return join(userDataDir, 'models', 'voice');
}

/**
 * URL de téléchargement d'un modèle : l'URL officielle, ou
 * `<miroir>/<nom de l'archive>`. Le miroir suit la règle de `checkServerUrl`
 * (https, sauf localhost et Tailscale). L'empreinte reste celle du catalogue.
 */
export function modelDownloadUrl(source: DownloadedVoiceModelSource, mirror?: string): string {
  if (mirror === undefined || mirror.trim() === '') return source.url;
  const check = checkServerUrl(mirror);
  if (!check.ok) {
    throw new AtelierError(
      'settings/invalid',
      check.reason === 'insecure_http'
        ? 'Le miroir des modèles doit être en https:// (http:// seulement pour localhost ou Tailscale).'
        : 'Adresse du miroir des modèles invalide.',
      { details: { field: 'modelSourceUrl' } },
    );
  }
  const base = check.url.href.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(source.archiveName)}`;
}

/** SHA-256 hexadécimal d'un fichier. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Octets libres du volume (`statfs`), pour un utilisateur non privilégié. */
export async function statfsFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return info.bavail * info.bsize;
}

const DOWNLOADS_DIR = '.downloads';
const STAGING_PREFIX = '.staging-';
const MANIFEST = 'manifest.json';
const DEFAULT_DISK_MARGIN = 64 * 1024 * 1024;

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

function invalid(message: string, details: Record<string, unknown> = {}): AtelierError {
  return new AtelierError('voice/model_invalid', message, { details });
}

function downloadFailed(
  message: string,
  retryable: boolean,
  details: Record<string, unknown> = {},
  cause?: unknown,
): AtelierError {
  return new AtelierError('voice/download_failed', message, { retryable, details, cause });
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function cancelled(): AtelierError {
  return downloadFailed('Installation annulée.', true, { reason: 'cancelled' });
}

function toSerialized(error: unknown): SerializedAtelierError {
  if (isAtelierError(error)) return error.toJSON();
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message, retryable: false };
}

interface Progress {
  receivedBytes: number;
  totalBytes: number;
}

/** Gestionnaire des modèles de voix. Une instance par app, créée par le main. */
export class VoiceModelManager {
  private readonly root: string;
  private readonly bundledDir: string;
  private readonly catalog: readonly VoiceCatalogEntry[];
  private readonly fetchImpl: typeof fetch;
  private readonly freeBytes: (path: string) => Promise<number>;
  private readonly tar: TarRunner;
  private readonly now: () => number;
  private readonly onModelChange: ((info: VoiceModelInfo) => void) | undefined;
  private readonly onStep: VoiceModelManagerOptions['onStep'];
  private readonly progressIntervalMs: number;
  private readonly diskMargin: number;

  private readonly installs = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; progress: Progress }
  >();
  private readonly errors = new Map<string, SerializedAtelierError>();
  private readonly bundledChecks = new Map<string, Promise<string | undefined>>();

  constructor(options: VoiceModelManagerOptions) {
    this.root = options.rootDir;
    this.bundledDir = options.bundledDir;
    this.catalog = options.catalog ?? VOICE_MODEL_CATALOG;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.freeBytes = options.freeBytes ?? statfsFreeBytes;
    this.tar = options.tar ?? systemTar;
    this.now = options.now ?? Date.now;
    this.onModelChange = options.onModelChange;
    this.onStep = options.onStep;
    this.progressIntervalMs = options.progressIntervalMs ?? 250;
    this.diskMargin = options.diskMarginBytes ?? DEFAULT_DISK_MARGIN;
  }

  /** Entrée du catalogue ; `voice/model_missing` si l'identifiant est inconnu. */
  entry(id: string): VoiceCatalogEntry {
    const entry = this.catalog.find((e) => e.id === id);
    if (!entry) {
      throw new AtelierError('voice/model_missing', `Modèle inconnu : ${id}`, { details: { id } });
    }
    return entry;
  }

  /** Dossier d'installation d'une version. */
  modelDir(entry: Pick<VoiceCatalogEntry, 'id' | 'version'>): string {
    return join(this.root, modelDirName(entry));
  }

  private partialPath(entry: VoiceCatalogEntry): string {
    return join(this.root, DOWNLOADS_DIR, `${modelDirName(entry)}.partial`);
  }

  /**
   * À appeler au démarrage : supprime les dossiers temporaires et les dossiers
   * finaux sans `manifest.json` valide (installation interrompue par un crash).
   * Les `.partial` sont gardés pour la reprise.
   */
  async init(): Promise<void> {
    await mkdir(join(this.root, DOWNLOADS_DIR), { recursive: true });
    for (const name of await readdir(this.root)) {
      if (name === DOWNLOADS_DIR) continue;
      const path = join(this.root, name);
      if (name.startsWith(STAGING_PREFIX) || name.endsWith('.manifest.tmp')) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      const at = name.lastIndexOf('@');
      if (at <= 0) continue;
      const id = name.slice(0, at);
      if (this.installs.has(id)) continue;
      const manifest = await this.readManifest(path);
      if (!manifest || manifest.id !== id || manifest.version !== name.slice(at + 1)) {
        await rm(path, { recursive: true, force: true });
      }
    }
  }

  /** État de tous les modèles du catalogue. */
  async status(): Promise<VoiceModelInfo[]> {
    return Promise.all(this.catalog.map((entry) => this.info(entry.id)));
  }

  /** État d'un modèle. */
  async info(id: string): Promise<VoiceModelInfo> {
    const entry = this.entry(id);
    if (entry.source.kind === 'bundled') {
      const issue = await this.checkBundled(entry);
      if (issue === undefined) return toModelInfo(entry, 'installed');
      return toModelInfo(entry, 'error', {
        error: invalid(issue, { id }).toJSON(),
      });
    }
    const running = this.installs.get(id);
    if (running) return toModelInfo(entry, 'downloading', { progress: { ...running.progress } });
    if (await this.isInstalled(entry)) return toModelInfo(entry, 'installed');
    const error = this.errors.get(id);
    if (error) return toModelInfo(entry, 'error', { error });
    return toModelInfo(entry, 'absent');
  }

  /** Vrai si la version du catalogue est installée et conforme. */
  async isInstalled(entry: VoiceCatalogEntry): Promise<boolean> {
    if (entry.source.kind !== 'download') return (await this.checkBundled(entry)) === undefined;
    const dir = this.modelDir(entry);
    const manifest = await this.readManifest(dir);
    if (!manifest) return false;
    if (
      manifest.id !== entry.id ||
      manifest.version !== entry.version ||
      manifest.sha256 !== entry.source.sha256
    ) {
      return false;
    }
    for (const file of entry.source.files) {
      if ((await fileSize(join(dir, file.path))) !== file.bytes) return false;
    }
    return true;
  }

  /**
   * Chemins des fichiers d'un modèle prêt à charger (process de
   * reconnaissance) ; `voice/model_missing` s'il n'est pas installé.
   */
  async resolve(id: string): Promise<ResolvedVoiceModel> {
    const entry = this.entry(id);
    if (entry.source.kind === 'bundled') {
      const issue = await this.checkBundled(entry);
      if (issue !== undefined) throw invalid(issue, { id });
      return {
        id,
        version: entry.version,
        dir: this.bundledDir,
        files: { [entry.source.file]: join(this.bundledDir, entry.source.file) },
      };
    }
    if (!(await this.isInstalled(entry))) {
      throw new AtelierError('voice/model_missing', `Modèle non installé : ${entry.label}`, {
        details: { id },
      });
    }
    const dir = this.modelDir(entry);
    const files: Record<string, string> = {};
    for (const file of entry.source.files) files[file.path] = join(dir, file.path);
    return { id, version: entry.version, dir, files };
  }

  /**
   * Versions installées qui ne sont plus celles du catalogue de l'app. Rien
   * n'est mis à jour en silence : le main propose la mise à jour, qui est un
   * {@link install} de la nouvelle version (l'ancienne est supprimée après la bascule).
   */
  async pendingUpdates(): Promise<VoiceModelUpdate[]> {
    const updates: VoiceModelUpdate[] = [];
    for (const entry of this.catalog) {
      if (entry.source.kind !== 'download') continue;
      if (await this.isInstalled(entry)) continue;
      for (const version of await this.installedVersions(entry.id)) {
        if (version === entry.version) continue;
        updates.push({ id: entry.id, installedVersion: version, catalogVersion: entry.version });
      }
    }
    return updates;
  }

  /** Versions d'un modèle présentes sur le disque, avec un manifeste valide. */
  async installedVersions(id: string): Promise<string[]> {
    const versions: string[] = [];
    for (const name of await this.listRoot()) {
      if (!name.startsWith(`${id}@`)) continue;
      const version = name.slice(id.length + 1);
      const manifest = await this.readManifest(join(this.root, name));
      if (manifest?.id === id && manifest.version === version) versions.push(version);
    }
    return versions;
  }

  /** Installe la version du catalogue depuis la source officielle ou un miroir. */
  async install(id: string, options: InstallOptions = {}): Promise<void> {
    const entry = this.entry(id);
    const source = this.downloadSource(entry);
    const url = modelDownloadUrl(source, options.sourceUrl);
    const origin: VoiceModelOrigin =
      options.sourceUrl !== undefined && options.sourceUrl.trim() !== '' ? 'mirror' : 'official';
    return this.run(entry, options.signal, async (signal, progress) => {
      await this.step(entry, 'disk');
      const partial = this.partialPath(entry);
      const already = (await fileSize(partial)) ?? 0;
      await this.ensureDiskSpace(
        Math.max(0, source.bytes - Math.min(already, source.bytes)) + entryDiskBytes(entry),
      );
      await this.step(entry, 'download');
      await this.download(entry, source, url, partial, signal, progress);
      await this.installArchive(entry, source, partial, origin, signal);
    });
  }

  /**
   * Installe depuis une archive hors ligne choisie par l'utilisateur. L'archive
   * est copiée (en calculant son empreinte) puis contrôlée par le **même**
   * SHA-256 du catalogue avant toute extraction.
   */
  async importArchive(
    id: string,
    archivePath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const entry = this.entry(id);
    const source = this.downloadSource(entry);
    return this.run(entry, options.signal, async (signal, progress) => {
      await this.step(entry, 'disk');
      const size = await fileSize(archivePath);
      if (size === undefined) {
        throw invalid(`Archive introuvable : ${archivePath}`, { id, reason: 'not_found' });
      }
      if (size !== source.bytes) {
        throw invalid(
          `Cette archive ne correspond pas au modèle ${entry.label} (taille ${String(size)} octets, ${String(source.bytes)} attendus).`,
          { id, reason: 'size_mismatch' },
        );
      }
      await this.ensureDiskSpace(source.bytes + entryDiskBytes(entry));
      await this.step(entry, 'download');
      const copy = join(this.root, DOWNLOADS_DIR, `${modelDirName(entry)}.import-${randomUUID()}`);
      try {
        await this.copyWithProgress(archivePath, copy, source.bytes, signal, progress, entry);
        await this.installArchive(entry, source, copy, 'import', signal);
      } finally {
        await rm(copy, { force: true });
      }
    });
  }

  /** Annule une installation en cours (le `.partial` est gardé pour la reprise). */
  cancel(id: string): void {
    this.installs.get(id)?.controller.abort();
  }

  /**
   * Supprime toutes les versions d'un modèle téléchargé, et son `.partial`.
   * Un modèle embarqué ne se supprime pas (`settings/invalid`).
   */
  async remove(id: string): Promise<void> {
    const entry = this.entry(id);
    if (entry.source.kind === 'bundled') {
      throw new AtelierError(
        'settings/invalid',
        `${entry.label} fait partie de l'app et ne peut pas être supprimé.`,
        { details: { id } },
      );
    }
    const running = this.installs.get(id);
    if (running) {
      running.controller.abort();
      await running.promise.catch(() => undefined);
    }
    for (const name of await this.listRoot()) {
      if (name.startsWith(`${id}@`))
        await rm(join(this.root, name), { recursive: true, force: true });
    }
    const downloads = join(this.root, DOWNLOADS_DIR);
    for (const name of await readdir(downloads).catch(() => [] as string[])) {
      if (name.startsWith(`${id}@`)) await rm(join(downloads, name), { force: true });
    }
    this.errors.delete(id);
    this.emit(toModelInfo(entry, 'absent'));
  }

  // ---------------------------------------------------------------- interne

  private downloadSource(entry: VoiceCatalogEntry): DownloadedVoiceModelSource {
    if (entry.source.kind !== 'download') {
      throw new AtelierError(
        'settings/invalid',
        `${entry.label} fait partie de l'app : rien à installer.`,
        { details: { id: entry.id } },
      );
    }
    return entry.source;
  }

  /** Une seule installation par modèle à la fois : un second appel attend la première. */
  private run(
    entry: VoiceCatalogEntry,
    outerSignal: AbortSignal | undefined,
    task: (signal: AbortSignal, progress: Progress) => Promise<void>,
  ): Promise<void> {
    const existing = this.installs.get(entry.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else
        outerSignal.addEventListener(
          'abort',
          () => {
            controller.abort();
          },
          { once: true },
        );
    }
    const progress: Progress = { receivedBytes: 0, totalBytes: entry.source.bytes };
    const promise = (async () => {
      this.errors.delete(entry.id);
      this.emit(toModelInfo(entry, 'downloading', { progress: { ...progress } }));
      try {
        if (!(await this.isInstalled(entry))) await task(controller.signal, progress);
        this.installs.delete(entry.id);
        this.emit(toModelInfo(entry, 'installed'));
      } catch (error: unknown) {
        this.installs.delete(entry.id);
        const final =
          isAbort(error, controller.signal) && !isAtelierError(error) ? cancelled() : error;
        const serialized = toSerialized(final);
        const isCancel = serialized.details?.['reason'] === 'cancelled';
        if (isCancel) {
          this.emit(toModelInfo(entry, 'absent'));
        } else {
          this.errors.set(entry.id, serialized);
          this.emit(toModelInfo(entry, 'error', { error: serialized }));
        }
        throw final;
      }
    })();
    this.installs.set(entry.id, { promise, controller, progress });
    return promise;
  }

  private async step(entry: VoiceCatalogEntry, step: VoiceInstallStep): Promise<void> {
    await this.onStep?.(entry.id, step);
  }

  private async ensureDiskSpace(needed: number): Promise<void> {
    await mkdir(join(this.root, DOWNLOADS_DIR), { recursive: true });
    const free = await this.freeBytes(this.root);
    const required = needed + this.diskMargin;
    if (free < required) {
      throw downloadFailed(
        `Place disque insuffisante : ${formatBytes(required)} nécessaires, ${formatBytes(free)} disponibles.`,
        false,
        { reason: 'disk_full', requiredBytes: required, availableBytes: free },
      );
    }
  }

  private async download(
    entry: VoiceCatalogEntry,
    source: DownloadedVoiceModelSource,
    url: string,
    partial: string,
    signal: AbortSignal,
    progress: Progress,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let start = (await fileSize(partial)) ?? 0;
      if (start > source.bytes) {
        await rm(partial, { force: true });
        start = 0;
      }
      progress.receivedBytes = start;
      if (start === source.bytes) return;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          redirect: 'follow',
          signal,
          headers: start > 0 ? { Range: `bytes=${String(start)}-` } : {},
        });
      } catch (error: unknown) {
        if (isAbort(error, signal)) throw cancelled();
        throw downloadFailed(`Téléchargement impossible : ${url}`, true, { url }, error);
      }

      let append = false;
      if (response.status === 206 && start > 0) {
        const range = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        if (range?.[1] === undefined || Number(range[1]) !== start) {
          await response.body?.cancel();
          await rm(partial, { force: true });
          continue; // reprise refusée ou incohérente : on repart de zéro
        }
        append = true;
      } else if (response.status === 416 && start > 0) {
        await response.body?.cancel();
        await rm(partial, { force: true });
        continue;
      } else if (response.status !== 200) {
        await response.body?.cancel();
        throw downloadFailed(
          `Le serveur a répondu ${String(response.status)} pour ${url}`,
          response.status >= 500 || response.status === 429 || response.status === 408,
          { url, status: response.status },
        );
      }
      if (!response.body) throw downloadFailed(`Réponse vide pour ${url}`, true, { url });
      if (!append) progress.receivedBytes = 0;

      await this.writeBody(entry, response.body, partial, append, source.bytes, signal, progress);
      if (progress.receivedBytes < source.bytes) {
        throw downloadFailed('Téléchargement interrompu avant la fin.', true, {
          url,
          receivedBytes: progress.receivedBytes,
          totalBytes: source.bytes,
        });
      }
      return;
    }
    throw downloadFailed(`La reprise du téléchargement a échoué : ${url}`, true, { url });
  }

  private async writeBody(
    entry: VoiceCatalogEntry,
    body: ReadableStream<Uint8Array>,
    path: string,
    append: boolean,
    total: number,
    signal: AbortSignal,
    progress: Progress,
  ): Promise<void> {
    const handle = await open(path, append ? 'a' : 'w');
    let lastEmit = 0;
    try {
      for await (const chunk of body) {
        if (signal.aborted) throw cancelled();
        if (progress.receivedBytes + chunk.byteLength > total) {
          await handle.close().catch(() => undefined);
          await rm(path, { force: true });
          throw invalid('Le fichier téléchargé est plus gros que prévu.', {
            id: entry.id,
            reason: 'oversize',
          });
        }
        await handle.write(chunk);
        progress.receivedBytes += chunk.byteLength;
        const now = this.now();
        if (now - lastEmit >= this.progressIntervalMs) {
          lastEmit = now;
          this.emit(toModelInfo(entry, 'downloading', { progress: { ...progress } }));
        }
      }
    } catch (error: unknown) {
      if (isAtelierError(error)) throw error;
      if (isAbort(error, signal)) throw cancelled();
      throw downloadFailed(
        'Connexion coupée pendant le téléchargement.',
        true,
        {
          receivedBytes: progress.receivedBytes,
        },
        error,
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async copyWithProgress(
    from: string,
    to: string,
    total: number,
    signal: AbortSignal,
    progress: Progress,
    entry: VoiceCatalogEntry,
  ): Promise<void> {
    progress.receivedBytes = 0;
    const handle = await open(to, 'w');
    let lastEmit = 0;
    try {
      for await (const chunk of createReadStream(from, { signal })) {
        const bytes = chunk as Buffer;
        if (progress.receivedBytes + bytes.byteLength > total) {
          throw invalid("Archive modifiée pendant l'import.", { id: entry.id, reason: 'oversize' });
        }
        await handle.write(bytes);
        progress.receivedBytes += bytes.byteLength;
        const now = this.now();
        if (now - lastEmit >= this.progressIntervalMs) {
          lastEmit = now;
          this.emit(toModelInfo(entry, 'downloading', { progress: { ...progress } }));
        }
      }
    } catch (error: unknown) {
      if (isAtelierError(error)) throw error;
      if (isAbort(error, signal)) throw cancelled();
      throw invalid(`Lecture de l'archive impossible : ${from}`, {
        id: entry.id,
        reason: 'unreadable',
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Étapes 3 à 6, communes au téléchargement et à l'import. */
  private async installArchive(
    entry: VoiceCatalogEntry,
    source: DownloadedVoiceModelSource,
    archive: string,
    origin: VoiceModelOrigin,
    signal: AbortSignal,
  ): Promise<void> {
    await this.step(entry, 'verify');
    const size = await fileSize(archive);
    const actual = await sha256File(archive);
    if (size !== source.bytes || actual !== source.sha256) {
      await rm(archive, { force: true });
      throw invalid(
        `L'empreinte de ${entry.label} ne correspond pas au catalogue de l'app : fichier corrompu ou modifié.`,
        { id: entry.id, reason: 'sha256_mismatch', expected: source.sha256, actual },
      );
    }

    await this.step(entry, 'extract');
    const listing = await this.tar(tarListArgs(archive), signal);
    if (listing.code !== 0) {
      throw invalid(`Archive illisible (tar, code ${String(listing.code)}).`, {
        id: entry.id,
        reason: 'tar_list',
      });
    }
    const listIssue = checkArchiveEntries(listing.stdout.split('\n'), source.rootDir, source.files);
    if (listIssue !== undefined)
      throw invalid(listIssue, { id: entry.id, reason: 'unexpected_entry' });

    const staging = join(this.root, `${STAGING_PREFIX}${modelDirName(entry)}-${randomUUID()}`);
    await mkdir(staging);
    try {
      const extract = await this.tar(tarExtractArgs(archive, staging), signal);
      if (extract.code !== 0) {
        throw invalid(`Extraction impossible (tar, code ${String(extract.code)}).`, {
          id: entry.id,
          reason: 'tar_extract',
        });
      }

      await this.step(entry, 'check');
      const top = await readdir(staging);
      if (top.length !== 1 || top[0] !== source.rootDir) {
        throw invalid("Contenu de l'archive inattendu à la racine.", {
          id: entry.id,
          reason: 'unexpected_entry',
        });
      }
      const extracted = join(staging, source.rootDir);
      const treeIssue = await checkExtractedTree(extracted, source.files);
      if (treeIssue !== undefined)
        throw invalid(treeIssue, { id: entry.id, reason: 'unexpected_entry' });

      await this.step(entry, 'commit');
      const finalDir = this.modelDir(entry);
      await rm(finalDir, { recursive: true, force: true }); // reste d'une installation invalide
      await rename(extracted, finalDir);

      await this.step(entry, 'manifest');
      const manifest: VoiceModelManifest = {
        id: entry.id,
        version: entry.version,
        sha256: source.sha256,
        origin,
        installedAt: new Date(this.now()).toISOString(),
        files: source.files.map((file) => ({ ...file })),
      };
      const tmp = join(this.root, `${modelDirName(entry)}-${randomUUID()}.manifest.tmp`);
      await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
      await rename(tmp, join(finalDir, MANIFEST));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    // Après la bascule : archive téléchargée et anciennes versions supprimées.
    await this.step(entry, 'cleanup');
    await rm(archive, { force: true });
    for (const name of await this.listRoot()) {
      if (name.startsWith(`${entry.id}@`) && name !== modelDirName(entry)) {
        await rm(join(this.root, name), { recursive: true, force: true });
      }
    }
  }

  private async readManifest(dir: string): Promise<VoiceModelManifest | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'));
      return isManifest(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async listRoot(): Promise<string[]> {
    try {
      return await readdir(this.root);
    } catch {
      return [];
    }
  }

  private checkBundled(entry: VoiceCatalogEntry): Promise<string | undefined> {
    const source = entry.source;
    if (source.kind !== 'bundled') return Promise.resolve(undefined);
    let check = this.bundledChecks.get(entry.id);
    if (!check) {
      const path = join(this.bundledDir, source.file);
      check = (async () => {
        const size = await fileSize(path);
        if (size === undefined) return `Modèle intégré absent de l'app : ${source.file}`;
        if (size !== source.bytes || (await sha256File(path)) !== source.sha256) {
          return `Modèle intégré corrompu : ${source.file}`;
        }
        return undefined;
      })();
      this.bundledChecks.set(entry.id, check);
    }
    return check;
  }

  private emit(info: VoiceModelInfo): void {
    this.onModelChange?.(info);
  }
}

function isManifest(value: unknown): value is VoiceModelManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['version'] === 'string' &&
    typeof v['sha256'] === 'string' &&
    typeof v['installedAt'] === 'string' &&
    Array.isArray(v['files'])
  );
}

/** Taille lisible, en français (« 464,6 Mo »). */
export function formatBytes(bytes: number): string {
  const units = ['octets', 'Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace('.', ',');
  return `${text} ${units[unit] ?? 'octets'}`;
}
