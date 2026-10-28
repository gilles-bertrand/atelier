/**
 * Conversion des documents bureautiques en markdown : docx via `mammoth`
 * (HTML sémantique → turndown, tableaux en markdown), xlsx via `exceljs`
 * (une table markdown par feuille, 200 lignes au plus).
 */
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { AtelierError } from '@atelier/shared';

/** Nombre maximal de lignes converties par feuille. */
export const MAX_SHEET_ROWS = 200;
/** Nombre maximal de colonnes converties par feuille. */
export const MAX_SHEET_COLUMNS = 50;

// ---------------------------------------------------------------------------
// docx

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X'))
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Texte brut d'un fragment HTML (balises retirées, entités décodées). */
function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>\s*<p[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Échappe une cellule de tableau markdown. */
export function escapeCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n|\r/g, ' ')
    .trim();
}

/** Construit une table markdown (la première ligne sert d'en-tête). */
export function markdownTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const pad = (r: string[]): string[] =>
    Array.from({ length: width }, (_, i) => escapeCell(r[i] ?? ''));
  const [head = [], ...body] = rows;
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [
    line(pad(head)),
    line(Array.from({ length: width }, () => '---')),
    ...body.map((r) => line(pad(r))),
  ].join('\n');
}

/** Convertit un `<table>` produit par mammoth (structure simple et régulière). */
function htmlTableToMarkdown(table: string): string {
  const rows: string[][] = [];
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(row[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      htmlText(c[1] ?? ''),
    );
    rows.push(cells);
  }
  return rows.length > 0 ? markdownTable(rows) : '';
}

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  service.addRule('image', {
    filter: 'img',
    replacement: (_content: string, node: { getAttribute?: (n: string) => string | null }) => {
      const alt = node.getAttribute?.('alt')?.trim();
      return alt ? `[image : ${alt}]` : '[image]';
    },
  });
  return service;
}

function tidy(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^(\s*)(-|\d+\.) {2,}/gm, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Convertit un document Word (.docx) en markdown. */
export async function docxToMarkdown(data: Uint8Array): Promise<string> {
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(data) },
      // Les images ne sont pas transmises au modèle : pas de data: URL de plusieurs Mo.
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) },
    );
    html = result.value;
  } catch (error) {
    throw new AtelierError('tool/failed', 'Document Word illisible ou endommagé.', {
      cause: error,
    });
  }
  const turndown = createTurndown();
  // Les tableaux sont convertis à part (turndown ne les gère pas sans plugin).
  const parts: string[] = [];
  let last = 0;
  for (const match of html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)) {
    const before = html.slice(last, match.index);
    if (before.trim()) parts.push(turndown.turndown(before));
    parts.push(htmlTableToMarkdown(match[0]));
    last = match.index + match[0].length;
  }
  const rest = html.slice(last);
  if (rest.trim()) parts.push(turndown.turndown(rest));
  return tidy(parts.join('\n\n'));
}

// ---------------------------------------------------------------------------
// xlsx

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatDate(date: Date): string {
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

/** Valeur lisible d'une cellule exceljs (formules : résultat calculé). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return formatDate(value);
  if (isRecord(value)) {
    if (Array.isArray(value.richText)) {
      return value.richText
        .map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
        .join('');
    }
    if ('formula' in value || 'sharedFormula' in value) {
      return 'result' in value ? cellText(value.result) : '';
    }
    if (typeof value.error === 'string') return value.error;
    if (typeof value.text === 'string') return value.text;
    if ('hyperlink' in value && typeof value.hyperlink === 'string') return value.hyperlink;
  }
  return '';
}

/** Convertit un classeur Excel (.xlsx) en tableaux markdown, une section par feuille. */
export async function xlsxToMarkdown(data: Uint8Array): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  } catch (error) {
    throw new AtelierError('tool/failed', 'Classeur Excel illisible ou endommagé.', {
      cause: error,
    });
  }
  const sheets = workbook.worksheets;
  const sections: string[] = [
    `Classeur : ${sheets.length} feuille${sheets.length > 1 ? 's' : ''} (${sheets.map((s) => `« ${s.name} »`).join(', ')}).`,
  ];
  for (const sheet of sheets) {
    const rowCount = sheet.actualRowCount;
    const columnCount = sheet.actualColumnCount;
    const hidden = sheet.state !== 'visible' ? ', masquée' : '';
    const title = `## Feuille « ${sheet.name} » (${rowCount} ligne${rowCount > 1 ? 's' : ''} × ${columnCount} colonne${columnCount > 1 ? 's' : ''}${hidden})`;
    if (rowCount === 0) {
      sections.push(`${title}\n\n(feuille vide)`);
      continue;
    }
    const width = Math.min(sheet.columnCount, MAX_SHEET_COLUMNS);
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_SHEET_ROWS) return;
      rows.push(Array.from({ length: width }, (_, i) => cellText(row.getCell(i + 1).value)));
    });
    const notes: string[] = [];
    if (rowCount > MAX_SHEET_ROWS) {
      notes.push(
        `${MAX_SHEET_ROWS} premières lignes non vides sur ${rowCount} : pour le reste, utilise pandas ou openpyxl via bash.`,
      );
    }
    if (sheet.columnCount > MAX_SHEET_COLUMNS)
      notes.push(`${MAX_SHEET_COLUMNS} premières colonnes sur ${sheet.columnCount}.`);
    sections.push(
      [title, '', markdownTable(rows), ...(notes.length ? ['', `(${notes.join(' ')})`] : [])].join(
        '\n',
      ),
    );
  }
  return sections.join('\n\n');
}
