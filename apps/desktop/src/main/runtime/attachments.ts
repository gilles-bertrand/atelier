/**
 * Pièces jointes glissées dans le chat : la copie dans
 * `<dossier>/.atelier/uploads/` est faite par `importAttachment` de
 * `@atelier/documents` ; ici, la conversion en `Attachment` (shared).
 */
import { basename, extname } from 'node:path';
import { importAttachment } from '@atelier/documents';
import type { Attachment } from '@atelier/shared';

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

/** Copie les fichiers déposés dans le dossier de travail (dans l'ordre). */
export async function importAttachments(
  workspace: string,
  hostPaths: readonly string[],
): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const hostPath of hostPaths) {
    const imported = await importAttachment(hostPath, workspace);
    const mimeType = guessMimeType(imported.name);
    out.push({
      path: imported.relativePath,
      name: basename(hostPath),
      size: imported.size,
      ...(mimeType ? { mimeType } : {}),
    });
  }
  return out;
}
