/**
 * Pièces jointes (glisser-déposer dans le chat) : le fichier choisi par
 * l'utilisateur est copié dans `<dossier>/.atelier/uploads/`, seul endroit où
 * l'agent pourra le lire ; son chemin relatif est mentionné au modèle.
 */
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AtelierError } from '@atelier/shared';
import { resolveWorkspacePath } from '@atelier/agent-core';
import { formatBytes } from './fs.js';

/** Dossier des pièces jointes, relatif au dossier de travail. */
export const UPLOADS_DIR = '.atelier/uploads';
/** Taille maximale d'une pièce jointe. */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/** Pièce jointe importée. */
export interface ImportedAttachment {
  /** Chemin relatif au dossier de travail (à mentionner au modèle). */
  relativePath: string;
  /** Chemin absolu de la copie. */
  absolutePath: string;
  /** Nom de fichier final (peut différer de l'original en cas de doublon). */
  name: string;
  size: number;
  /** Vrai si un fichier identique existait déjà (pas de nouvelle copie). */
  reused: boolean;
}

/** Options de {@link importAttachment}. */
export interface ImportAttachmentOptions {
  maxBytes?: number;
}

/**
 * Nom de fichier sûr : sans séparateur, caractère de contrôle ni point initial
 * (pas de fichier caché, pas de `..`), 120 caractères au plus.
 */
export function sanitizeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const ext = path
    .extname(base)
    .replace(/[^a-zA-Z0-9.]/g, '')
    .slice(0, 16);
  let stem = base.slice(0, base.length - path.extname(base).length);
  stem = stem
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  stem = stem.slice(0, 120 - ext.length) || 'piece-jointe';
  return `${stem}${ext}`;
}

async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Copie un fichier déposé par l'utilisateur dans `<workspace>/.atelier/uploads/`.
 * Un doublon de nom reçoit un suffixe (« facture (2).pdf ») ; un fichier
 * identique déjà importé est réutilisé.
 *
 * @param hostPath - Fichier choisi par l'utilisateur (n'importe où sur le Mac).
 * @param workspace - Dossier de travail.
 * @throws AtelierError `tool/invalid_input` (pas un fichier),
 *   `documents/too_large`, `tool/path_outside_workspace` si `.atelier` sort du dossier.
 */
export async function importAttachment(
  hostPath: string,
  workspace: string,
  options: ImportAttachmentOptions = {},
): Promise<ImportedAttachment> {
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const source = path.resolve(hostPath);
  const info = await stat(source).catch((error: unknown) => {
    throw new AtelierError('tool/invalid_input', `Fichier introuvable : ${hostPath}`, {
      cause: error,
    });
  });
  if (!info.isFile()) {
    throw new AtelierError(
      'tool/invalid_input',
      `« ${path.basename(source)} » n'est pas un fichier.`,
    );
  }
  if (info.size > maxBytes) {
    throw new AtelierError(
      'documents/too_large',
      `Pièce jointe trop volumineuse (${formatBytes(info.size)}, maximum ${formatBytes(maxBytes)}).`,
      { details: { size: info.size, maxBytes } },
    );
  }

  const uploads = await resolveWorkspacePath(workspace, UPLOADS_DIR);
  await mkdir(uploads.absolutePath, { recursive: true });
  const name = sanitizeFileName(path.basename(source));
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let sourceHash: string | undefined;

  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    // Re-vérifie à chaque essai : `.atelier/uploads` ne doit pas être un lien sortant.
    const target = await resolveWorkspacePath(workspace, `${UPLOADS_DIR}/${candidate}`);
    if (target.absolutePath === source) {
      return {
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        name: candidate,
        size: info.size,
        reused: true,
      };
    }
    if (target.exists) {
      const existing = await stat(target.absolutePath);
      if (existing.isFile() && existing.size === info.size) {
        sourceHash ??= await fileHash(source);
        if ((await fileHash(target.absolutePath)) === sourceHash) {
          return {
            relativePath: target.relativePath,
            absolutePath: target.absolutePath,
            name: candidate,
            size: info.size,
            reused: true,
          };
        }
      }
      continue;
    }
    try {
      // COPYFILE_EXCL : jamais d'écrasement (ni de suivi d'un lien posé entre-temps).
      await copyFile(source, target.absolutePath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) continue;
      throw error;
    }
    return {
      relativePath: target.relativePath,
      absolutePath: target.absolutePath,
      name: candidate,
      size: info.size,
      reused: false,
    };
  }
  throw new AtelierError('tool/failed', `Trop de pièces jointes nommées « ${name} ».`);
}
