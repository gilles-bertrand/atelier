/**
 * Règle des dossiers de travail : conversations, tâches planifiées et dossiers
 * de projet (ADR-003) obéissent aux mêmes refus.
 */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { AtelierError, isSameOrInside } from '@atelier/shared';

/** Message commun : un dossier précis, pas tout le disque ni tout le dossier personnel. */
const TOO_WIDE =
  'Choisissez un dossier précis : ni la racine du disque ni votre dossier personnel entier.';

/** Refuse la racine, le `$HOME` et tout dossier qui le contient (`/Users`…). */
function refuseTooWide(dir: string, homes: readonly string[]): void {
  if (dir === sep || homes.some((home) => isSameOrInside(dir, home))) {
    throw new AtelierError('sandbox/invalid_workspace', TOO_WIDE, { details: { dir } });
  }
}

/**
 * Dossier de travail acceptable : absolu, existant, ni la racine du disque, ni
 * le `$HOME` entier, ni un dossier qui le contient. La règle vaut aussi pour le
 * chemin canonique : un lien symbolique vers `~` ou vers `/` est refusé, comme
 * le fait la VM (`assertMountableWorkspace`), sans quoi les outils de l'agent,
 * qui résolvent les liens, recevraient tout le dossier personnel.
 *
 * @returns Le chemin normalisé, tel que donné (sans `..`).
 */
export async function assertWorkspace(dir: string, home: string): Promise<string> {
  if (!isAbsolute(dir)) throw new AtelierError('sandbox/invalid_workspace', 'Chemin non absolu.');
  const normalized = resolve(dir);
  refuseTooWide(normalized, [resolve(home)]);
  let info;
  try {
    info = await stat(normalized);
  } catch (error) {
    throw new AtelierError('sandbox/invalid_workspace', `Dossier introuvable : ${normalized}`, {
      cause: error,
    });
  }
  if (!info.isDirectory())
    throw new AtelierError('sandbox/invalid_workspace', `Pas un dossier : ${normalized}`);
  // Chemin canonique (liens symboliques résolus) : mêmes refus.
  const canonical = await realpath(normalized);
  const canonicalHome = await realpath(home).catch(() => resolve(home));
  refuseTooWide(canonical, [resolve(home), canonicalHome]);
  return normalized;
}
