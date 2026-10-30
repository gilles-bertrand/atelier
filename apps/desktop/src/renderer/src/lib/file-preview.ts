/**
 * Aperçu des fichiers dans le panneau droit : mode d'affichage d'après
 * l'extension, URL du protocole `atelier-file://` (servi et filtré par le main,
 * voir `main/file-preview.ts`) et lecture des tableaux CSV / TSV.
 */
import { extensionOf } from './file-types';

/**
 * `document` : Word converti en markdown par le main ; `workbook` : Excel converti
 * en feuilles JSON par le main.
 */
export type PreviewMode =
  'image' | 'pdf' | 'markdown' | 'table' | 'text' | 'document' | 'workbook' | 'none';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const MARKDOWN = new Set(['md', 'markdown']);
const TABLE = new Set(['csv', 'tsv']);
/** Même liste que le main : HTML et SVG sont montrés en source, jamais interprétés. */
const TEXT = new Set([
  'txt',
  'log',
  'json',
  'jsonl',
  'ndjson',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'html',
  'htm',
  'svg',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'sh',
  'bash',
  'zsh',
  'sql',
  'r',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'php',
  'swift',
  'kt',
]);

/** Comment afficher un fichier dans l'aperçu (`none` : seulement « Ouvrir »). */
export function previewMode(path: string): PreviewMode {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  // `.env` n'a pas d'extension au sens de extensionOf.
  const ext = name === '.env' ? 'env' : extensionOf(name);
  if (ext === undefined) return 'none';
  if (IMAGE.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (MARKDOWN.has(ext)) return 'markdown';
  if (TABLE.has(ext)) return 'table';
  if (ext === 'docx') return 'document';
  if (ext === 'xlsx' || ext === 'xlsm') return 'workbook';
  if (TEXT.has(ext)) return 'text';
  return 'none';
}

/**
 * URL d'aperçu d'un fichier. `revision` change à chaque nouvelle version du
 * fichier dans la conversation : le navigateur recharge au lieu de garder l'ancienne.
 */
export function filePreviewUrl(absolutePath: string, revision = 0): string {
  return `atelier-file://preview/?path=${encodeURIComponent(absolutePath)}&v=${String(revision)}`;
}

export interface ParsedTable {
  rows: string[][];
  /** Vrai si des lignes ont été omises (au-delà de `maxRows`). */
  truncated: boolean;
}

/** Séparateur probable d'un CSV : `;` (Excel en français) ou `,`, d'après la première ligne. */
export function detectDelimiter(text: string, path: string): string {
  if (extensionOf(path) === 'tsv') return '\t';
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  const count = (sep: string) => firstLine.split(sep).length - 1;
  if (count('\t') > Math.max(count(';'), count(','))) return '\t';
  return count(';') > count(',') ? ';' : ',';
}

/** Lecture CSV (RFC 4180 : guillemets, `""` échappé, retours à la ligne entre guillemets). */
export function parseDelimited(text: string, delimiter: string, maxRows = 1000): ParsedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pushRow = (): boolean => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    return rows.length >= maxRows;
  };
  for (; i < text.length; i++) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (pushRow()) return { rows, truncated: i < text.length - 1 };
    } else field += char;
  }
  if (field !== '' || row.length > 0) pushRow();
  return { rows, truncated: false };
}
