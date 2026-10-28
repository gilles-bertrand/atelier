/**
 * Préparation des images pour le modèle vision : décodage (HEIC via
 * `heic-convert`, le reste via `sharp`), orientation EXIF, réduction à 1568 px
 * sur le grand côté, ré-encodage en PNG (captures, texte net) ou JPEG (photos).
 */
import convertHeic from 'heic-convert';
import sharp from 'sharp';
import { AtelierError } from '@atelier/shared';
import type { ImageFormat } from './detect.js';

/** Grand côté maximal envoyé au modèle vision. */
export const MAX_IMAGE_SIDE = 1568;
/** Limite de pixels acceptée en entrée (protège contre les « bombes » d'image). */
const MAX_INPUT_PIXELS = 100_000_000;

/** Image prête pour le modèle vision. */
export interface PreparedImage {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  /** Dimensions d'origine (après orientation EXIF). */
  originalWidth: number;
  originalHeight: number;
}

/**
 * Décode, oriente, réduit et ré-encode une image.
 * @throws AtelierError `tool/failed` si l'image est illisible.
 */
export async function prepareImage(input: Uint8Array, format: ImageFormat): Promise<PreparedImage> {
  try {
    let source: Buffer = Buffer.from(input);
    if (format === 'heic') {
      // sharp (libvips précompilé) ne décode pas le HEVC : conversion en JPEG d'abord.
      source = Buffer.from(await convertHeic({ buffer: source, format: 'JPEG', quality: 0.92 }));
    }
    const base = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate();
    const meta = await base.clone().metadata();
    // `rotate()` sans argument applique l'orientation EXIF : 5 à 8 permutent les côtés.
    const swapped = (meta.orientation ?? 1) >= 5;
    const originalWidth = swapped ? meta.height : meta.width;
    const originalHeight = swapped ? meta.width : meta.height;
    const lossless = format === 'png' || format === 'gif' || format === 'webp' || format === 'tiff';
    const resized = base.resize({
      width: MAX_IMAGE_SIDE,
      height: MAX_IMAGE_SIDE,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const { data, info } = lossless
      ? await resized.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await resized
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 88, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
    return {
      data,
      mediaType: lossless ? 'image/png' : 'image/jpeg',
      width: info.width,
      height: info.height,
      originalWidth,
      originalHeight,
    };
  } catch (error) {
    if (error instanceof AtelierError) throw error;
    throw new AtelierError('tool/failed', 'Image illisible ou endommagée.', { cause: error });
  }
}

/** Résumé lisible des dimensions (« 2400×1200 px, réduite à 1568×784 px »). */
export function describeDimensions(image: PreparedImage): string {
  const original = `${image.originalWidth}×${image.originalHeight} px`;
  return image.width !== image.originalWidth || image.height !== image.originalHeight
    ? `${original}, réduite à ${image.width}×${image.height} px`
    : original;
}
