/**
 * Type d'un fichier d'après son extension (ou son type MIME) : famille, icône,
 * teinte et libellé court. Les teintes suivent les conventions connues : vert
 * tableur, bleu traitement de texte, rouge PDF, orange présentation.
 */
import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

export type FileKind =
  'sheet' | 'doc' | 'pdf' | 'slides' | 'image' | 'code' | 'data' | 'archive' | 'text' | 'other';

const EXTENSIONS: Record<Exclude<FileKind, 'other'>, readonly string[]> = {
  sheet: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'numbers'],
  doc: ['docx', 'doc', 'odt', 'rtf', 'pages'],
  pdf: ['pdf'],
  slides: ['pptx', 'ppt', 'key', 'odp'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'bmp', 'tif', 'tiff'],
  code: [
    'py',
    'js',
    'mjs',
    'cjs',
    'ts',
    'tsx',
    'jsx',
    'sh',
    'bash',
    'zsh',
    'html',
    'htm',
    'css',
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
  ],
  data: ['json', 'jsonl', 'ndjson', 'yaml', 'yml', 'xml', 'toml'],
  archive: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz'],
  text: ['txt', 'md', 'markdown', 'log'],
};

const KIND_BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map(
  (Object.entries(EXTENSIONS) as [FileKind, readonly string[]][]).flatMap(([kind, list]) =>
    list.map((ext) => [ext, kind] as const),
  ),
);

export const FILE_ICONS: Record<FileKind, LucideIcon> = {
  sheet: FileSpreadsheet,
  doc: FileText,
  pdf: FileText,
  slides: Presentation,
  image: FileImage,
  code: FileCode,
  data: FileBraces,
  archive: FileArchive,
  text: FileText,
  other: File,
};

/** Tuile (fond doux et icône teintée). Classes écrites en entier pour Tailwind. */
export const FILE_TILE_CLASSES: Record<FileKind, string> = {
  sheet: 'bg-file-sheet-soft text-file-sheet',
  doc: 'bg-file-doc-soft text-file-doc',
  pdf: 'bg-file-pdf-soft text-file-pdf',
  slides: 'bg-file-slides-soft text-file-slides',
  image: 'bg-file-image-soft text-file-image',
  code: 'bg-file-code-soft text-file-code',
  data: 'bg-file-data-soft text-file-data',
  archive: 'bg-file-archive-soft text-file-archive',
  text: 'bg-muted text-muted-foreground',
  other: 'bg-muted text-muted-foreground',
};

/** Icône seule, sans tuile (pièces jointes compactes). */
export const FILE_ICON_CLASSES: Record<FileKind, string> = {
  sheet: 'text-file-sheet',
  doc: 'text-file-doc',
  pdf: 'text-file-pdf',
  slides: 'text-file-slides',
  image: 'text-file-image',
  code: 'text-file-code',
  data: 'text-file-data',
  archive: 'text-file-archive',
  text: 'text-muted-foreground',
  other: 'text-muted-foreground',
};

/** Extension en minuscules (`ventes.T3.xlsx` → `xlsx`) ; aucune pour `.env` ou `Makefile`. */
export function extensionOf(name: string): string | undefined {
  const base = name.split(/[\\/]/).at(-1) ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

export interface FileType {
  kind: FileKind;
  /** Extension en capitales, quatre caractères au plus (« XLSX »). */
  label?: string;
}

/** Famille et libellé d'un fichier ; le type MIME départage une image sans extension connue. */
export function fileType(name: string, mimeType?: string): FileType {
  const ext = extensionOf(name);
  const known = ext === undefined ? undefined : KIND_BY_EXTENSION.get(ext);
  const kind: FileKind = known ?? (mimeType?.startsWith('image/') ? 'image' : 'other');
  return ext === undefined ? { kind } : { kind, label: ext.slice(0, 4).toUpperCase() };
}
