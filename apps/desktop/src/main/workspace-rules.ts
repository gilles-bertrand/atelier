/**
 * Règle des dossiers de travail : conversations, tâches planifiées et dossiers
 * de projet (ADR-003) obéissent aux mêmes refus.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { AtelierError } from '@atelier/shared';

/** Dossier de travail acceptable : absolu, existant, ni la racine ni le `$HOME` complet. */
export async function assertWorkspace(dir: string, home: string): Promise<string> {
  if (!isAbsolute(dir)) throw new AtelierError('sandbox/invalid_workspace', 'Chemin non absolu.');
  const normalized = resolve(dir);
  if (normalized === sep || normalized === resolve(home)) {
    throw new AtelierError(
      'sandbox/invalid_workspace',
      'Choisissez un dossier précis : ni la racine du disque ni votre dossier personnel entier.',
    );
  }
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
  return normalized;
}
