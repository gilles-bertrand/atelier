/**
 * Réglages de l'application, persistés en JSON dans `userData/settings.json`.
 * Les secrets n'y figurent jamais (voir `secrets-store.ts`).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AtelierError,
  checkServerUrl,
  DEFAULT_MODEL,
  type AppSettings,
  type AppSettingsPatch,
  type SearchProviderId,
} from '@atelier/shared';

/** Réglages par défaut (premier lancement). */
export function defaultSettings(home: string): AppSettings {
  return {
    llm: { baseUrl: '', model: DEFAULT_MODEL, thinking: true },
    sandbox: { cpus: 4, memoryGiB: 4, diskGiB: 30, networkEnabledByDefault: false },
    search: { provider: 'searxng' },
    skillsDir: join(home, 'Atelier', 'skills'),
    mcpConfigPath: join(home, 'Atelier', 'mcp.json'),
    onboardingCompleted: false,
  };
}

const SEARCH_PROVIDERS: readonly SearchProviderId[] = ['searxng', 'ollama', 'brave'];

/**
 * Applique un patch (profond au premier niveau) et valide le résultat.
 * Lève `AtelierError` si une valeur est invalide : rien n'est enregistré.
 */
export function applySettingsPatch(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const next: AppSettings = {
    ...current,
    ...(patch.skillsDir !== undefined ? { skillsDir: patch.skillsDir } : {}),
    ...(patch.mcpConfigPath !== undefined ? { mcpConfigPath: patch.mcpConfigPath } : {}),
    ...(patch.onboardingCompleted !== undefined
      ? { onboardingCompleted: patch.onboardingCompleted }
      : {}),
    ...(patch.privacyAcceptedAt !== undefined
      ? { privacyAcceptedAt: patch.privacyAcceptedAt }
      : {}),
    ...(patch.openAtLogin !== undefined ? { openAtLogin: patch.openAtLogin } : {}),
    llm: clearOptionalLlm({ ...current.llm, ...stripUndefined(patch.llm) }),
    sandbox: { ...current.sandbox, ...stripUndefined(patch.sandbox) },
    search: { ...current.search, ...stripUndefined(patch.search) },
  };
  validateSettings(next);
  return next;
}

/** Vérifie la cohérence des réglages ; lève une `AtelierError` explicite. */
export function validateSettings(settings: AppSettings): void {
  const { llm, sandbox, search } = settings;
  if (llm.baseUrl !== '') {
    const check = checkServerUrl(llm.baseUrl);
    if (!check.ok) {
      throw new AtelierError(
        check.reason === 'insecure_http' ? 'llm/insecure_url' : 'settings/invalid',
        `URL du serveur refusée (${check.reason}) : ${llm.baseUrl}`,
      );
    }
  }
  if (llm.model.trim() === '') throw invalid('Le modèle ne peut pas être vide.');
  if (llm.numCtx !== undefined && (!Number.isInteger(llm.numCtx) || llm.numCtx < 2048)) {
    throw invalid('La fenêtre de contexte doit être un entier ≥ 2048.');
  }
  if (!Number.isInteger(sandbox.cpus) || sandbox.cpus < 1 || sandbox.cpus > 32) {
    throw invalid('Le nombre de CPU de la VM doit être compris entre 1 et 32.');
  }
  if (!Number.isInteger(sandbox.memoryGiB) || sandbox.memoryGiB < 2 || sandbox.memoryGiB > 64) {
    throw invalid('La mémoire de la VM doit être comprise entre 2 et 64 Gio.');
  }
  if (!SEARCH_PROVIDERS.includes(search.provider)) {
    throw invalid(`Fournisseur de recherche inconnu : ${search.provider as string}`);
  }
  if (settings.skillsDir.trim() === '' || settings.mcpConfigPath.trim() === '') {
    throw invalid('Les chemins des skills et de mcp.json sont obligatoires.');
  }
}

/**
 * `visionModel: ''` et `numCtx: 0` dans un patch signifient « revenir à
 * l'automatique » (modèle principal, contexte lu sur le serveur) : un patch ne
 * peut pas transporter `undefined`.
 */
function clearOptionalLlm(llm: AppSettings['llm']): AppSettings['llm'] {
  const { visionModel, numCtx, ...rest } = llm;
  return {
    ...rest,
    ...(visionModel !== undefined && visionModel.trim() !== '' ? { visionModel } : {}),
    ...(numCtx !== undefined && numCtx !== 0 ? { numCtx } : {}),
  };
}

function invalid(message: string): AtelierError {
  return new AtelierError('settings/invalid', message);
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Fusionne un JSON lu sur disque (éventuellement ancien ou partiel) avec les défauts. */
export function mergeWithDefaults(defaults: AppSettings, raw: unknown): AppSettings {
  if (!isRecord(raw)) return defaults;
  const pick = <T extends object>(key: string, base: T): T =>
    isRecord(raw[key]) ? { ...base, ...(raw[key] as Partial<T>) } : base;
  const merged: AppSettings = {
    ...defaults,
    llm: pick('llm', defaults.llm),
    sandbox: pick('sandbox', defaults.sandbox),
    search: pick('search', defaults.search),
    skillsDir: typeof raw['skillsDir'] === 'string' ? raw['skillsDir'] : defaults.skillsDir,
    mcpConfigPath:
      typeof raw['mcpConfigPath'] === 'string' ? raw['mcpConfigPath'] : defaults.mcpConfigPath,
    onboardingCompleted: raw['onboardingCompleted'] === true,
    ...(typeof raw['privacyAcceptedAt'] === 'string'
      ? { privacyAcceptedAt: raw['privacyAcceptedAt'] }
      : {}),
    ...(raw['openAtLogin'] === true ? { openAtLogin: true } : {}),
  };
  try {
    validateSettings(merged);
    return merged;
  } catch {
    // Fichier corrompu ou édité à la main : on repart des défauts plutôt que de bloquer l'app.
    return defaults;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Écouteur de changement de réglages. */
export type SettingsListener = (next: AppSettings, previous: AppSettings) => void;

/** Réglages persistés, avec notification des changements. */
export class SettingsStore {
  readonly #file: string;
  #current: AppSettings;
  readonly #listeners = new Set<SettingsListener>();
  #writing: Promise<void> = Promise.resolve();

  private constructor(file: string, current: AppSettings) {
    this.#file = file;
    this.#current = current;
  }

  /** Charge `file` (absent ou illisible : réglages par défaut). */
  static async load(file: string, home: string): Promise<SettingsStore> {
    const defaults = defaultSettings(home);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      raw = undefined;
    }
    return new SettingsStore(file, mergeWithDefaults(defaults, raw));
  }

  get(): AppSettings {
    return this.#current;
  }

  /** Applique un patch, l'enregistre (écriture atomique) et prévient les écouteurs. */
  async update(patch: AppSettingsPatch): Promise<AppSettings> {
    const previous = this.#current;
    const next = applySettingsPatch(previous, patch);
    this.#current = next;
    await this.#persist(next);
    for (const listener of this.#listeners) listener(next, previous);
    return next;
  }

  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #persist(settings: AppSettings): Promise<void> {
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      await rename(tmp, this.#file);
    };
    this.#writing = this.#writing.then(run, run);
    return this.#writing;
  }
}
