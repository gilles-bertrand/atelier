/**
 * Pièces jointes glissées dans le chat : copie dans
 * `<dossier>/.atelier/uploads/` (brief §2bis), nom unique, type MIME deviné.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { AtelierError, type Attachment } from '@atelier/shared';

export const UPLOADS_DIR = '.atelier/uploads';
/** Taille maximale d'une pièce jointe. */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Type MIME d'après l'extension, ou `undefined`. */
export function guessMimeType(name: string): string | undefined {
  return MIME_BY_EXTENSION[extname(name).toLowerCase()];
}

/** Nom de fichier sûr (pas de séparateur, pas de fichier caché, longueur bornée). */
export function safeFileName(name: string): string {
  const cleaned = basename(name)
    .replace(/[/\\:\0]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const ext = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, 120);
  return `${stem === '' ? 'fichier' : stem}${ext.slice(0, 16)}`;
}

/** Nom libre dans `taken` : `rapport.pdf`, puis `rapport (2).pdf`… */
export function uniqueName(
  name: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const attempt = async (n: number): Promise<string> => {
    const candidate = n === 1 ? name : `${stem} (${String(n)})${ext}`;
    return (await taken(candidate)) ? attempt(n + 1) : candidate;
  };
  return attempt(1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Copie les fichiers dans le dossier de travail et renvoie les pièces jointes. */
export async function importAttachments(
  workspace: string,
  hostPaths: readonly string[],
): Promise<Attachment[]> {
  const targetDir = join(workspace, UPLOADS_DIR);
  await mkdir(targetDir, { recursive: true });
  const out: Attachment[] = [];
  for (const source of hostPaths) {
    let info;
    try {
      info = await stat(source);
    } catch (error) {
      throw new AtelierError('tool/failed', `Fichier introuvable : ${basename(source)}`, {
        cause: error,
      });
    }
    if (!info.isFile()) {
      throw new AtelierError(
        'documents/unsupported_type',
        `« ${basename(source)} » n'est pas un fichier.`,
      );
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new AtelierError('documents/too_large', `« ${basename(source)} » dépasse 200 Mo.`);
    }
    const name = await uniqueName(safeFileName(basename(source)), (c) =>
      exists(join(targetDir, c)),
    );
    await copyFile(source, join(targetDir, name));
    const mimeType = guessMimeType(name);
    out.push({
      path: `${UPLOADS_DIR}/${name}`,
      name: basename(source),
      size: info.size,
      ...(mimeType ? { mimeType } : {}),
    });
  }
  return out;
}
