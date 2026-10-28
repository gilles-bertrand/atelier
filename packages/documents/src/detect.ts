/**
 * Détection du type de fichier : signature binaire (magic bytes, via
 * `file-type`) d'abord, extension ensuite. Une extension trompeuse ne suffit pas
 * à faire passer un binaire pour du texte, ni un exécutable pour une image.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { looksBinary } from './encoding.js';

/** Famille de traitement. */
export type DocumentKind = 'text' | 'pdf' | 'image' | 'docx' | 'xlsx' | 'unsupported';

/** Format d'image accepté (entrée de `sharp`, ou de `heic-convert` pour le HEIC). */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'heic' | 'avif' | 'tiff';

/** Résultat de la détection. */
export interface DetectedType {
  kind: DocumentKind;
  /** Type MIME détecté (signature) ou déduit (extension), si connu. */
  mime?: string;
  /** Format d'image, pour `kind === 'image'`. */
  imageFormat?: ImageFormat;
  /** Libellé lisible du type détecté, pour les messages de refus. */
  label: string;
}

/** Taille de l'échantillon lu pour la détection. */
const SAMPLE_BYTES = 64 * 1024;

const IMAGE_BY_EXT: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
  heic: 'heic',
  heif: 'heic',
  avif: 'avif',
  tif: 'tiff',
  tiff: 'tiff',
};

/** Types que `file-type` reconnaît mais qui restent du texte. */
const TEXT_MIMES = new Set(['application/xml', 'image/svg+xml', 'application/x-ndjson']);

const OFFICE_LABELS: Record<string, string> = {
  doc: 'Word 97-2003 (.doc)',
  xls: 'Excel 97-2003 (.xls)',
  ppt: 'PowerPoint 97-2003 (.ppt)',
  pptx: 'PowerPoint (.pptx)',
  odt: 'OpenDocument texte (.odt)',
  ods: 'OpenDocument tableur (.ods)',
};

/** Lit les premiers octets d'un fichier. */
export async function readSample(absolutePath: string, bytes = SAMPLE_BYTES): Promise<Uint8Array> {
  const handle = await open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Extension en minuscules, sans le point. */
export function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * Détermine le traitement d'un fichier à partir de son chemin et de ses premiers
 * octets.
 */
export async function detectType(filePath: string, sample: Uint8Array): Promise<DetectedType> {
  const ext = extensionOf(filePath);
  const magic = await fileTypeFromBuffer(sample);

  if (magic) {
    if (magic.mime === 'application/pdf') return { kind: 'pdf', mime: magic.mime, label: 'PDF' };
    const imageFormat = IMAGE_BY_EXT[magic.ext];
    if (imageFormat) {
      return {
        kind: 'image',
        mime: magic.mime,
        imageFormat,
        label: `image ${magic.ext.toUpperCase()}`,
      };
    }
    if (magic.ext === 'heic' || magic.mime === 'image/heic' || magic.mime === 'image/heif') {
      return { kind: 'image', mime: 'image/heic', imageFormat: 'heic', label: 'image HEIC' };
    }
    if (magic.ext === 'docx') return { kind: 'docx', mime: magic.mime, label: 'Word (.docx)' };
    if (magic.ext === 'xlsx') return { kind: 'xlsx', mime: magic.mime, label: 'Excel (.xlsx)' };
    // Archive ZIP générique : un docx/xlsx dont les entrées ne sont pas dans l'échantillon.
    if (magic.ext === 'zip' && (ext === 'docx' || ext === 'xlsx')) {
      return ext === 'docx'
        ? { kind: 'docx', mime: magic.mime, label: 'Word (.docx)' }
        : { kind: 'xlsx', mime: magic.mime, label: 'Excel (.xlsx)' };
    }
    if (!TEXT_MIMES.has(magic.mime) && !magic.mime.startsWith('text/')) {
      const label = OFFICE_LABELS[magic.ext] ?? `${magic.ext.toUpperCase()} (${magic.mime})`;
      return { kind: 'unsupported', mime: magic.mime, label };
    }
  }

  if (looksBinary(sample)) {
    const label = OFFICE_LABELS[ext] ?? (ext ? `binaire .${ext}` : 'binaire');
    return { kind: 'unsupported', label };
  }
  return { kind: 'text', ...(magic ? { mime: magic.mime } : {}), label: 'texte' };
}
