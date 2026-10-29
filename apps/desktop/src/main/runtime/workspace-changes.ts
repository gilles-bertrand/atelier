/**
 * Détection des fichiers produits par les outils qui n'ont pas de carte propre
 * (bash dans la VM, skills, connecteurs MCP…) : on photographie le dossier de
 * travail (chemin, taille, mtime) au début du tour puis après chaque outil, et
 * chaque fichier créé ou modifié devient une carte cliquable (#44).
 *
 * La photo ignore `.atelier/` (pièces jointes, état interne), les entrées
 * cachées et les dossiers de dépendances ; au-delà d'un plafond d'entrées, la
 * détection est abandonnée pour le tour plutôt que de ralentir l'agent.
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileCard, ToolDisplay } from '@atelier/shared';

/** Taille et date de modification d'un fichier de la photo. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** Photo du dossier : chemin relatif (séparateur `/`) → empreinte. */
export type WorkspaceSnapshot = ReadonlyMap<string, FileStamp>;

export interface SnapshotOptions {
  /** Nombre maximal d'entrées parcourues (fichiers + dossiers). */
  maxEntries?: number;
  /** Profondeur maximale de dossiers. */
  maxDepth?: number;
}

/** Dossiers jamais parcourus (dépendances, caches) en plus des entrées cachées. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '__pycache__', 'venv']);

export const DEFAULT_MAX_ENTRIES = 5000;
export const DEFAULT_MAX_DEPTH = 8;
/** Cartes au plus par outil (une archive décompressée ne doit pas inonder le chat). */
export const MAX_CARDS_PER_TOOL = 20;

/**
 * Photographie le dossier de travail. Renvoie `undefined` si le dossier est
 * illisible ou trop gros (détection abandonnée, jamais d'erreur).
 */
export async function snapshotWorkspace(
  root: string,
  options: SnapshotOptions = {},
): Promise<WorkspaceSnapshot | undefined> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const files = new Map<string, FileStamp>();
  let entries = 0;
  const queue: { dir: string; prefix: string; depth: number }[] = [
    { dir: root, prefix: '', depth: 0 },
  ];
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      let dirents: Dirent[];
      try {
        dirents = await readdir(next.dir, { withFileTypes: true });
      } catch (error) {
        // Sous-dossier disparu ou illisible : on l'ignore ; la racine, non.
        if (next.depth === 0) throw error;
        continue;
      }
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        entries += 1;
        if (entries > maxEntries) return undefined;
        const relative = next.prefix + dirent.name;
        const absolute = join(next.dir, dirent.name);
        if (dirent.isDirectory()) {
          if (next.depth + 1 < maxDepth && !IGNORED_DIRECTORIES.has(dirent.name)) {
            queue.push({ dir: absolute, prefix: `${relative}/`, depth: next.depth + 1 });
          }
        } else if (dirent.isFile()) {
          try {
            const info = await lstat(absolute);
            files.set(relative, { size: info.size, mtimeMs: info.mtimeMs });
          } catch {
            // Fichier supprimé entre readdir et lstat.
          }
        }
        // Liens symboliques et fichiers spéciaux ignorés.
      }
    }
  } catch {
    return undefined;
  }
  return files;
}

/** Fichier créé ou modifié entre deux photos. */
export interface WorkspaceChange {
  path: string;
  action: 'created' | 'modified';
  size: number;
  mtimeMs: number;
}

/** Fichiers créés ou modifiés (les suppressions ne donnent pas de carte), plus récents d'abord. */
export function diffSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  for (const [path, stamp] of after) {
    const previous = before.get(path);
    if (!previous) {
      changes.push({ path, action: 'created', ...stamp });
    } else if (previous.size !== stamp.size || previous.mtimeMs !== stamp.mtimeMs) {
      changes.push({ path, action: 'modified', ...stamp });
    }
  }
  return changes.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

/**
 * Suivi des fichiers d'un tour. `start()` pose la photo de référence ;
 * `afterTool()` renvoie les cartes des fichiers apparus ou modifiés depuis la
 * photo précédente, hors celui que l'outil présente déjà lui-même (carte ou diff).
 */
export class WorkspaceChangeTracker {
  readonly #root: string;
  readonly #options: SnapshotOptions;
  #baseline: WorkspaceSnapshot | undefined;

  constructor(root: string, options: SnapshotOptions = {}) {
    this.#root = root;
    this.#options = options;
  }

  async start(): Promise<void> {
    this.#baseline = await snapshotWorkspace(this.#root, this.#options);
  }

  async afterTool(display: ToolDisplay | undefined): Promise<FileCard[]> {
    const after = await snapshotWorkspace(this.#root, this.#options);
    const before = this.#baseline;
    this.#baseline = after;
    if (!before || !after) return [];
    // Fichier déjà présenté par l'outil lui-même (write_file, present_file, edit_file).
    const ownCard =
      display?.type === 'file'
        ? display.file.path
        : display?.type === 'diff'
          ? display.path
          : undefined;
    return diffSnapshots(before, after)
      .filter((change) => change.path !== ownCard)
      .slice(0, MAX_CARDS_PER_TOOL)
      .map((change) => ({
        path: change.path,
        absolutePath: join(this.#root, ...change.path.split('/')),
        size: change.size,
        action: change.action,
      }));
  }
}
