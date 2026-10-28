/** Lecture défensive de fichiers déjà vérifiés par `resolveWorkspacePath`. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { AtelierError } from '@atelier/shared';

/**
 * Lit un fichier régulier sans suivre de lien symbolique final (`O_NOFOLLOW`) :
 * un lien posé entre la vérification du chemin et la lecture est refusé.
 *
 * @param maxBytes - Taille maximale acceptée.
 * @throws AtelierError `documents/too_large` au-delà de `maxBytes`,
 *   `tool/invalid_input` si ce n'est pas un fichier régulier.
 */
export async function readRegularFile(absolutePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.isDirectory()) {
      throw new AtelierError('tool/invalid_input', 'Ce chemin est un dossier : utilise list_dir.');
    }
    if (!info.isFile())
      throw new AtelierError('tool/invalid_input', "Ce chemin n'est pas un fichier ordinaire.");
    if (info.size > maxBytes) {
      throw new AtelierError(
        'documents/too_large',
        `Fichier trop volumineux (${formatBytes(info.size)}, maximum ${formatBytes(maxBytes)}).`,
        { details: { size: info.size, maxBytes } },
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Taille lisible en français (« 12,3 Mo »). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${units[unit] ?? 'Go'}`;
}
