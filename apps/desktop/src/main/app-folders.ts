/**
 * Dossier de l'utilisateur créé par l'app : `~/Documents/YodAI/`.
 *
 * Tout ce que l'utilisateur peut vouloir ouvrir dans le Finder y est regroupé :
 * `skills/`, `mcp.json`, `Projets/`. Restent ailleurs, par convention macOS ou
 * par nécessité : réglages, secrets, historique et VM (`userData`, dans
 * `~/Library/Application Support/`) et le cache `.atelier/` de chaque dossier
 * de travail (pièces jointes, rendus), qui doit rester à côté des fichiers.
 *
 * Avant le renommage en YodAI, ces éléments vivaient dans `~/Atelier/` :
 * {@link migrateLegacyFolders} les déplace au premier lancement.
 */
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppSettings, AppSettingsPatch } from '@atelier/shared';

/** Nom affiché de l'application et de son dossier. */
export const APP_NAME = 'YodAI';

/** `~/Documents/YodAI`. */
export function appFolder(home: string): string {
  return join(home, 'Documents', APP_NAME);
}

export function defaultSkillsDir(home: string): string {
  return join(appFolder(home), 'skills');
}

export function defaultMcpConfigPath(home: string): string {
  return join(appFolder(home), 'mcp.json');
}

export function defaultProjectsDir(home: string): string {
  return join(appFolder(home), 'Projets');
}

/** Ancien dossier (`~/Atelier`), avant le renommage. */
export function legacyAppFolder(home: string): string {
  return join(home, 'Atelier');
}

/** Résultat de la migration, pour le journal. */
export interface FolderMigration {
  /** Éléments déplacés : `[ancien, nouveau]`. */
  moved: [string, string][];
  /** Éléments laissés en place (la cible existait déjà) : l'ancien chemin reste utilisé. */
  kept: string[];
  /** Patch de réglages à appliquer (chemins par défaut mis à jour). */
  patch: AppSettingsPatch;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Déplace `~/Atelier/skills` et `~/Atelier/mcp.json` vers `~/Documents/YodAI/`,
 * seulement si les réglages pointent encore vers ces anciens chemins par défaut
 * (un chemin choisi par l'utilisateur n'est jamais touché) et que la cible
 * n'existe pas (rien n'est écrasé : dans ce cas l'ancien chemin reste réglé).
 *
 * Les dossiers de projets déjà créés ne bougent pas : leurs chemins sont
 * enregistrés dans l'historique, les conversations et les tâches planifiées.
 * Seuls les nouveaux projets iront dans `~/Documents/YodAI/Projets`.
 *
 * `~/Atelier` est supprimé s'il ne contient plus rien (hors `.DS_Store`).
 */
export async function migrateLegacyFolders(
  settings: Pick<AppSettings, 'skillsDir' | 'mcpConfigPath'>,
  home: string,
): Promise<FolderMigration> {
  const legacy = legacyAppFolder(home);
  const result: FolderMigration = { moved: [], kept: [], patch: {} };
  const items = [
    { key: 'skillsDir', from: join(legacy, 'skills'), to: defaultSkillsDir(home) },
    { key: 'mcpConfigPath', from: join(legacy, 'mcp.json'), to: defaultMcpConfigPath(home) },
  ] as const;

  for (const { key, from, to } of items) {
    if (settings[key] !== from) continue;
    if (await exists(from)) {
      if (await exists(to)) {
        result.kept.push(from);
        continue;
      }
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      result.moved.push([from, to]);
    }
    result.patch[key] = to;
  }

  await removeIfEmpty(legacy);
  return result;
}

/** Supprime `dir` s'il est vide, `.DS_Store` mis à part. */
async function removeIfEmpty(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  if (entries.some((name) => name !== '.DS_Store')) return;
  await rm(join(dir, '.DS_Store'), { force: true });
  await rmdir(dir).catch(() => undefined);
}
