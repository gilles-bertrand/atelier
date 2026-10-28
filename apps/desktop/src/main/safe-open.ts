/**
 * Ouverture sûre des fichiers présentés dans le chat (`file:open`, `file:reveal`).
 *
 * Le chemin vient du renderer et le fichier a pu être créé par l'agent (dans la
 * VM, piloté par du contenu web piégé) : un lien symbolique `rapport.pdf` vers
 * `Terminal.app` ferait lancer l'application par `shell.openPath`. D'où :
 * 1. résolution canonique (liens symboliques suivis) : la cible réelle doit être
 *    dans le dossier de travail d'une conversation connue ;
 * 2. pour `file:open`, cible = fichier régulier avec une extension de document
 *    de la LISTE BLANCHE (rien d'exécutable, pas de HTML/SVG qui peut porter du
 *    script) ; sinon, l'utilisateur passe par « Afficher dans le Finder ».
 */
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { isInside, tryResolveWorkspacePath } from '@atelier/agent-core';
import { AtelierError } from '@atelier/shared';

/** Extensions de documents que `file:open` confie à l'application par défaut. */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents et tableurs
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.rtf',
  '.csv',
  '.tsv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
  '.odt',
  '.ods',
  '.odp',
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.bmp',
  // Audio et vidéo
  '.mp3',
  '.m4a',
  '.wav',
  '.mp4',
  '.mov',
]);

/** Message commun : l'utilisateur peut toujours passer par le Finder. */
const USE_FINDER =
  'Par sécurité, Atelier n’ouvre directement que les documents (PDF, images, textes, tableurs…) : utilisez « Afficher dans le Finder ».';

export type OpenMode = 'open' | 'reveal';

/**
 * Valide une demande d'ouverture et renvoie le chemin RÉEL à transmettre au
 * système (jamais le lien symbolique). Lève une `AtelierError` sinon.
 */
export async function resolveOpenable(
  requested: string,
  workspaces: readonly string[],
  mode: OpenMode,
): Promise<string> {
  if (!isAbsolute(requested) || requested.includes('\0')) {
    throw new AtelierError('tool/invalid_input', `Chemin invalide : ${requested}`);
  }

  // Cible canonique, et uniquement si elle reste dans un dossier de travail connu
  // (resolveWorkspacePath refuse tout lien qui sort du dossier).
  let target: string | undefined;
  for (const workspace of workspaces) {
    const resolved = await tryResolveWorkspacePath(workspace, requested);
    if (resolved?.exists) {
      target = resolved.absolutePath;
      break;
    }
  }
  if (target === undefined) {
    throw new AtelierError(
      'tool/path_outside_workspace',
      `Fichier introuvable ou hors des dossiers de travail : ${requested}`,
    );
  }

  // Seconde résolution complète, puis vérification d'appartenance sur le chemin réel.
  const real = await realpath(target);
  const realRoots = await Promise.all(workspaces.map((w) => realpath(w).catch(() => undefined)));
  if (!realRoots.some((root) => root !== undefined && isInside(root, real))) {
    throw new AtelierError(
      'tool/path_outside_workspace',
      `Fichier hors des dossiers de travail : ${requested}`,
    );
  }

  const info = await stat(real);
  if (mode === 'reveal') {
    if (!info.isFile() && !info.isDirectory()) {
      throw new AtelierError('tool/failed', `Élément non affichable : ${requested}`);
    }
    return real;
  }
  // Un bundle (.app, .key…) est un dossier : jamais ouvert directement.
  if (!info.isFile() || !OPENABLE_EXTENSIONS.has(extname(real).toLowerCase())) {
    throw new AtelierError('tool/failed', USE_FINDER, { details: { kind: 'blocked_open' } });
  }
  return real;
}
