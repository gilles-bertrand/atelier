/** Parcours du dossier de travail et correspondance de motifs glob (sans dépendance). */
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FileCard } from '@atelier/shared';

/** Dossiers ignorés par défaut lors des parcours (bruit, volumineux). */
/** Dossiers jamais parcourus par glob / grep (`.atelier` : cache et rendus de `documents`). */
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '__pycache__',
  '.venv',
  '.atelier',
]);

/** Fichier rencontré pendant un parcours. */
export interface WalkEntry {
  /** Chemin absolu. */
  absolutePath: string;
  /** Chemin relatif à la racine du parcours, séparateurs `/`. */
  relativePath: string;
  /** Taille en octets. */
  size: number;
}

/**
 * Parcourt récursivement `root` (fichiers réguliers uniquement). Les liens
 * symboliques ne sont pas suivis : ils pourraient mener hors du dossier.
 */
export async function* walkFiles(
  root: string,
  options: { signal?: AbortSignal; maxFiles?: number } = {},
): AsyncGenerator<WalkEntry> {
  const maxFiles = options.maxFiles ?? 20_000;
  let seen = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (options.signal?.aborted) return;
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // Ordre de pile inversé pour garder un parcours alphabétique.
    const subdirs: string[] = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) subdirs.push(abs);
      } else if (entry.isFile()) {
        if (++seen > maxFiles) return;
        let size: number;
        try {
          size = (await lstat(abs)).size;
        } catch {
          continue;
        }
        yield {
          absolutePath: abs,
          relativePath: path.relative(root, abs).split(path.sep).join('/'),
          size,
        };
      }
    }
    stack.push(...subdirs.reverse());
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

/**
 * Convertit un motif glob en expression régulière.
 * Gère `**`, `*`, `?`, `{a,b}` et `[abc]`. Un motif sans `/` s'applique au nom de
 * fichier à n'importe quelle profondeur (comme `**\/motif`).
 */
export function globToRegExp(pattern: string): RegExp {
  let glob = pattern.trim().replace(/^\.\//, '');
  if (!glob.includes('/')) glob = `**/${glob}`;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` : zéro ou plusieurs dossiers ; `**` final : tout.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const alternatives = glob
          .slice(i + 1, end)
          .split(',')
          .map(escapeRegExp);
        re += `(?:${alternatives.join('|')})`;
        i = end;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
      } else {
        re += `[${glob.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Vrai si les premiers octets du fichier contiennent un octet nul (binaire probable). */
export async function looksBinary(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, 'r');
  try {
    const buf = Buffer.alloc(8_192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Type MIME déduit de l'extension, si connu. */
export function mimeFromPath(filePath: string): string | undefined {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

/** Construit une carte de fichier pour le chat. */
export function fileCard(
  relativePath: string,
  absolutePath: string,
  size: number,
  action: FileCard['action'],
): FileCard {
  const mimeType = mimeFromPath(absolutePath);
  return { path: relativePath, absolutePath, size, action, ...(mimeType ? { mimeType } : {}) };
}
