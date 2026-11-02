/**
 * Dossier de l'utilisateur créé par l'app : `~/YodAI/`.
 *
 * Hors de `~/Documents` à dessein : avec iCloud « Bureau et Documents », tout
 * `~/Documents` part dans iCloud (et peut être évincé du disque), ce qui
 * contredit la souveraineté des données.
 *
 * Tout ce que l'utilisateur peut vouloir ouvrir dans le Finder y est regroupé :
 * `skills/`, `mcp.json`, `Projets/`. Restent ailleurs, par convention macOS ou
 * par nécessité : réglages, secrets, historique et VM (`userData`, dans
 * `~/Library/Application Support/`) et le cache `.atelier/` de chaque dossier
 * de travail (pièces jointes, rendus), qui doit rester à côté des fichiers.
 *
 * Ces éléments ont vécu dans `~/Atelier/` (avant le renommage), puis
 * brièvement dans `~/Documents/YodAI/` : {@link migrateLegacyFolders} les
 * déplace au premier lancement.
 */
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppSettings, AppSettingsPatch } from '@atelier/shared';

/** Nom affiché de l'application et de son dossier. */
export const APP_NAME = 'YodAI';

/** `~/YodAI`. */
export function appFolder(home: string): string {
  return join(home, APP_NAME);
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

/**
 * Anciens dossiers, du plus ancien au plus récent : `~/Atelier` (avant le
 * renommage), puis `~/Documents/YodAI` (abandonné à cause d'iCloud).
 */
export function legacyAppFolders(home: string): string[] {
  return [join(home, 'Atelier'), join(home, 'Documents', APP_NAME)];
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
 * Déplace `skills/` et `mcp.json` d'un ancien dossier ({@link legacyAppFolders})
 * vers `~/YodAI/`, seulement si les réglages pointent encore vers un de ces
 * anciens chemins par défaut (un chemin choisi par l'utilisateur n'est jamais
 * touché) et que la cible n'existe pas (rien n'est écrasé : dans ce cas
 * l'ancien chemin reste réglé).
 *
 * Les dossiers de projets déjà créés ne bougent pas : leurs chemins sont
 * enregistrés dans l'historique, les conversations et les tâches planifiées.
 * Seuls les nouveaux projets iront dans `~/YodAI/Projets`.
 *
 * Chaque ancien dossier est supprimé s'il ne contient plus rien (hors
 * `.DS_Store` et un `Projets/` vide).
 */
export async function migrateLegacyFolders(
  settings: Pick<AppSettings, 'skillsDir' | 'mcpConfigPath'>,
  home: string,
): Promise<FolderMigration> {
  const legacyFolders = legacyAppFolders(home);
  const result: FolderMigration = { moved: [], kept: [], patch: {} };
  const items = [
    { key: 'skillsDir', name: 'skills', to: defaultSkillsDir(home) },
    { key: 'mcpConfigPath', name: 'mcp.json', to: defaultMcpConfigPath(home) },
  ] as const;

  for (const { key, name, to } of items) {
    const from = legacyFolders.map((folder) => join(folder, name)).find((p) => p === settings[key]);
    if (from === undefined) continue;
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

  for (const folder of legacyFolders) {
    await removeIfEmpty(join(folder, 'Projets'));
    await removeIfEmpty(folder);
  }
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
