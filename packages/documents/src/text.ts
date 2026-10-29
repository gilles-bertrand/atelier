/** Mise en forme du texte renvoyé au modèle : lignes numérotées, fenêtre offset/limit. */

/** Nombre maximal de lignes renvoyées par appel. */
export const MAX_LINES = 2000;
/** Longueur maximale d'une ligne (au-delà, elle est coupée). */
export const MAX_LINE_CHARS = 2000;
/**
 * Taille maximale par défaut du texte renvoyé par appel : ≈ 25 % d'une fenêtre
 * de 32 768 tokens (voir {@link outputCharsForContext}).
 */
export const MAX_OUTPUT_CHARS = 24_000;
/** Caractères par token retenus pour convertir un budget en tokens (texte français). */
const CHARS_PER_TOKEN = 3;

/**
 * Budget de sortie d'un appel de `read_file`, en caractères, dérivé de la
 * fenêtre de contexte du modèle : `share` de la fenêtre (25 % par défaut).
 */
export function outputCharsForContext(contextWindowTokens: number, share = 0.25): number {
  const chars = Math.floor(contextWindowTokens * share * CHARS_PER_TOKEN);
  return Math.max(2_000, chars);
}

/** Fenêtre de lignes demandée. */
export interface LineWindow {
  /** Première ligne (1 = début). */
  offset?: number;
  /** Nombre de lignes. */
  limit?: number;
}

/** Résultat de la mise en forme. */
export interface WindowedText {
  /** Corps (lignes numérotées ou non). */
  body: string;
  /** Première ligne renvoyée (1-based). */
  first: number;
  /** Dernière ligne renvoyée (1-based ; `first - 1` si aucune). */
  last: number;
  /** Nombre total de lignes. */
  total: number;
}

/** Découpe en lignes (CRLF et CR acceptés ; pas de ligne vide fantôme en fin). */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [ligne tronquée]` : line;
}

/**
 * Sélectionne la fenêtre `offset`/`limit` (2000 lignes et `maxChars` caractères
 * au plus) et numérote les lignes si demandé (format `     12\ttexte`).
 */
export function windowLines(
  text: string,
  window: LineWindow,
  numbered: boolean,
  maxChars = MAX_OUTPUT_CHARS,
): WindowedText {
  const lines = splitLines(text);
  const total = lines.length;
  const start = Math.max(1, window.offset ?? 1);
  const limit = Math.min(window.limit ?? MAX_LINES, MAX_LINES);
  const out: string[] = [];
  let chars = 0;
  let last = start - 1;
  for (let n = start; n <= total && n < start + limit; n++) {
    const raw = clip(lines[n - 1] ?? '');
    const line = numbered ? `${String(n).padStart(6)}\t${raw}` : raw;
    if (chars + line.length + 1 > maxChars && out.length > 0) break;
    out.push(line);
    chars += line.length + 1;
    last = n;
  }
  return { body: out.join('\n'), first: start, last, total };
}

/** En-tête indiquant la fenêtre renvoyée et comment lire la suite. */
export function windowHeader(window: WindowedText, unit = 'lignes'): string {
  if (window.total === 0) return '';
  if (window.last < window.first) {
    return `[${unit} : le fichier en compte ${window.total}, offset ${window.first} est au-delà de la fin]`;
  }
  if (window.first === 1 && window.last === window.total) return '';
  const more = window.last < window.total ? ` ; suite avec offset: ${window.last + 1}` : '';
  return `[${unit} ${window.first}-${window.last} sur ${window.total}${more}]`;
}
