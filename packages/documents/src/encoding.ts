/**
 * Décodage des fichiers texte : UTF-8 (avec ou sans BOM), UTF-16 (BOM), sinon
 * latin-1. Le repli latin-1 utilise windows-1252, sur-ensemble imprimable
 * d'ISO-8859-1 (c'est d'ailleurs ce que le standard WHATWG associe à « latin1 »),
 * qui couvre les fichiers produits par les vieux logiciels Windows (€, œ…).
 */

/** Encodage détecté. */
export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin-1';

/** Texte décodé. */
export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
  /** Vrai si un BOM a été trouvé (et retiré). */
  bom: boolean;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

/** Vrai si un BOM UTF-16 est présent (les octets nuls y sont alors normaux). */
export function hasUtf16Bom(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);
}

/**
 * Vrai si l'échantillon ressemble à du binaire : octet nul (hors UTF-16 avec
 * BOM) ou plus de 10 % de caractères de contrôle.
 */
export function looksBinary(sample: Uint8Array): boolean {
  if (sample.length === 0) return false;
  if (hasUtf16Bom(sample)) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    // Contrôles C0 hors tabulation, retours à la ligne, saut de page, échappement.
    if (
      byte < 0x20 &&
      byte !== 0x09 &&
      byte !== 0x0a &&
      byte !== 0x0d &&
      byte !== 0x0c &&
      byte !== 0x1b
    ) {
      control++;
    }
  }
  return control / sample.length > 0.1;
}

/** Décode un contenu texte en détectant son encodage. */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return {
      text: new TextDecoder('utf-8').decode(bytes.subarray(3)),
      encoding: 'utf-8',
      bom: true,
    };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      text: new TextDecoder('utf-16le').decode(bytes.subarray(2)),
      encoding: 'utf-16le',
      bom: true,
    };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      text: new TextDecoder('utf-16be').decode(bytes.subarray(2)),
      encoding: 'utf-16be',
      bom: true,
    };
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      encoding: 'utf-8',
      bom: false,
    };
  } catch {
    return { text: decodeWindows1252(bytes), encoding: 'latin-1', bom: false };
  }
}

/**
 * Caractères de windows-1252 pour 0x80-0x9F (le reste coïncide avec latin-1).
 * Décodage manuel : le `TextDecoder('windows-1252')` de Node rend ces octets
 * comme des contrôles C1 (ISO-8859-1 strict).
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const codes = Array.from(bytes.subarray(i, i + 8192), (b) =>
      b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b - 0x80] ?? b) : b,
    );
    out += String.fromCharCode(...codes);
  }
  return out;
}
