/**
 * Cache des extractions coûteuses (vision, conversions office) dans
 * `<dossier>/.atelier/cache/`. Clé = SHA-256 (hash du fichier + paramètres +
 * version du format). Le cache est « au mieux » : une erreur de lecture ou
 * d'écriture n'empêche jamais l'outil de répondre.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tryResolveWorkspacePath } from '@atelier/agent-core';

/** Dossier du cache, relatif au dossier de travail. */
export const CACHE_DIR = '.atelier/cache';
/** Version du format des entrées : l'incrémenter invalide tout le cache. */
const CACHE_VERSION = 1;

/** Empreinte SHA-256 (hexadécimale) d'un contenu. */
export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Paramètres d'une entrée de cache (sérialisés de façon stable). */
export type CacheKeyParts = Record<string, string | number | boolean | null | undefined>;

/** Clé de cache déterministe (ordre des champs indifférent). */
export function cacheKey(parts: CacheKeyParts): string {
  const entries = Object.entries(parts)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return sha256(JSON.stringify([CACHE_VERSION, entries]));
}

/** Cache texte adossé au dossier de travail. */
export interface ExtractionCache {
  get(parts: CacheKeyParts): Promise<string | undefined>;
  set(parts: CacheKeyParts, value: string): Promise<void>;
}

/** Cache inactif (tests, ou désactivé dans les options). */
export const noCache: ExtractionCache = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
};

/**
 * Résout un chemin du cache en vérifiant qu'il reste dans le dossier de travail
 * (un `.atelier` remplacé par un lien symbolique sortant est ignoré).
 */
async function entryPath(workspace: string, key: string): Promise<string | null> {
  const resolved = await tryResolveWorkspacePath(workspace, `${CACHE_DIR}/${key}.txt`);
  return resolved?.absolutePath ?? null;
}

/** Cache disque dans `<workspace>/.atelier/cache/`. */
export function createWorkspaceCache(workspace: string): ExtractionCache {
  return {
    async get(parts) {
      try {
        const file = await entryPath(workspace, cacheKey(parts));
        if (!file) return undefined;
        const info = await lstat(file);
        if (!info.isFile()) return undefined;
        return await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    async set(parts, value) {
      try {
        const file = await entryPath(workspace, cacheKey(parts));
        if (!file) return;
        await mkdir(path.dirname(file), { recursive: true });
        // Re-vérifie après création des dossiers, puis écriture atomique.
        const final = await entryPath(workspace, cacheKey(parts));
        if (final !== file) return;
        const tmp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, value, { encoding: 'utf8', flag: 'wx' });
          await rename(tmp, file);
        } finally {
          await rm(tmp, { force: true });
        }
      } catch {
        // Cache au mieux : on ignore.
      }
    },
  };
}
