/**
 * Aperçu des fichiers de la conversation dans le panneau droit, servi par le
 * protocole `atelier-file://preview/?path=<chemin absolu>`.
 *
 * Un protocole plutôt qu'un canal IPC : le renderer affiche directement les
 * images (`<img>`) et les PDF (visionneuse de Chromium dans une `<iframe>`), et
 * lit les textes avec `fetch`, sans copier de binaire à travers le pont.
 *
 * Mêmes garde-fous que `file:open` ({@link resolveOpenable}) : chemin canonique
 * (liens symboliques suivis) dans le dossier de travail d'une conversation
 * connue, fichier régulier. En plus :
 * - liste blanche de types, et type MIME FIXÉ ICI d'après l'extension réelle
 *   (`nosniff`) : un `.html` ou un `.svg` piégé est servi en `text/plain`, jamais
 *   interprété ;
 * - CSP `sandbox` sur toute réponse (sauf PDF, que la visionneuse doit pouvoir
 *   charger) : aucun script ne s'exécute même si la ressource est ouverte seule ;
 * - textes tronqués à {@link MAX_TEXT_BYTES} (en-tête `X-Atelier-Truncated`).
 */
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { AtelierError, isAtelierError } from '@atelier/shared';
import { docxToMarkdown, xlsxPreview } from './office-preview.js';
import { resolveOpenable } from './safe-open.js';

export const PREVIEW_SCHEME = 'atelier-file';
export const PREVIEW_HOST = 'preview';

/** Taille maximale lue pour un aperçu texte (au-delà : tronqué). */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** Taille maximale servie pour une image ou un PDF. */
export const MAX_BINARY_BYTES = 50 * 1024 * 1024;

/** Types MIME des binaires affichables (Chromium sait les décoder). */
const BINARY_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
};

/** Extensions lues comme du texte brut (code, données, HTML et SVG compris : jamais interprétés). */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.ndjson',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.html',
  '.htm',
  '.svg',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.r',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.php',
  '.swift',
  '.kt',
]);

/** Documents bureautiques convertis par le main avant l'aperçu (type MIME de la conversion). */
const CONVERTED_TYPES: Readonly<Record<string, string>> = {
  '.docx': 'text/markdown; charset=utf-8',
  '.xlsx': 'application/json; charset=utf-8',
  '.xlsm': 'application/json; charset=utf-8',
};
/** Taille maximale d'un document bureautique à convertir. */
export const MAX_OFFICE_BYTES = 20 * 1024 * 1024;

/** Type d'aperçu d'un chemin, d'après son extension (pour Word et Excel : type converti). */
export function previewMimeType(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  if (ext in CONVERTED_TYPES) return CONVERTED_TYPES[ext];
  if (ext in BINARY_TYPES) return BINARY_TYPES[ext];
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain; charset=utf-8';
  return undefined;
}

/** URL d'aperçu d'un chemin absolu (même construction que le renderer). */
export function previewUrl(absolutePath: string): string {
  return `${PREVIEW_SCHEME}://${PREVIEW_HOST}/?path=${encodeURIComponent(absolutePath)}`;
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  'tool/invalid_input': 400,
  'tool/path_outside_workspace': 403,
  'tool/failed': 415,
};

function failure(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

async function readHead(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Répond à une requête `atelier-file://` (fonction pure, I/O de fichiers seulement). */
export async function handlePreviewRequest(
  requestUrl: string,
  workspaces: readonly string[],
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return failure(400, 'URL d’aperçu invalide.');
  }
  const requested = url.searchParams.get('path');
  if (url.protocol !== `${PREVIEW_SCHEME}:` || url.hostname !== PREVIEW_HOST || !requested) {
    return failure(400, 'URL d’aperçu invalide.');
  }

  let real: string;
  try {
    // Mode « reveal » : chemin canonique dans un dossier de travail ; le type est vérifié ici.
    real = await resolveOpenable(requested, workspaces, 'reveal');
  } catch (error) {
    if (isAtelierError(error)) return failure(STATUS_BY_CODE[error.code] ?? 500, error.message);
    return failure(500, 'Aperçu impossible.');
  }

  const mimeType = previewMimeType(real);
  if (mimeType === undefined) return failure(415, 'Aucun aperçu pour ce type de fichier.');

  try {
    const info = await stat(real);
    if (!info.isFile()) return failure(415, 'Aucun aperçu pour un dossier.');
    const ext = extname(real).toLowerCase();
    let body: Uint8Array;
    let truncated = false;
    if (ext in CONVERTED_TYPES) {
      if (info.size > MAX_OFFICE_BYTES) {
        return failure(413, 'Fichier trop volumineux pour l’aperçu.');
      }
      const data = await readHead(real, info.size);
      const converted =
        ext === '.docx' ? await docxToMarkdown(data) : JSON.stringify(await xlsxPreview(data));
      body = new TextEncoder().encode(converted);
    } else {
      const text = mimeType.startsWith('text/');
      const limit = text ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
      if (!text && info.size > limit) return failure(413, 'Fichier trop volumineux pour l’aperçu.');
      body = await readHead(real, Math.min(info.size, limit));
      truncated = text && info.size > limit;
    }
    const headers: Record<string, string> = {
      'Content-Type': mimeType,
      'Content-Length': String(body.byteLength),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Atelier-Truncated',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    };
    // La visionneuse PDF a besoin de ses scripts ; tout le reste est inerte.
    if (mimeType !== 'application/pdf') {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self'";
    }
    if (truncated) headers['X-Atelier-Truncated'] = '1';
    return new Response(new Uint8Array(body), { status: 200, headers });
  } catch (error) {
    // Document endommagé : message de la conversion (« Classeur Excel illisible… »).
    if (error instanceof AtelierError) return failure(422, error.message);
    return failure(500, 'Lecture du fichier impossible.');
  }
}
