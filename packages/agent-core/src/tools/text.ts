/** Utilitaires de texte pour les sorties d'outils. */

/** Taille maximale par défaut d'une sortie renvoyée au modèle (10 ko). */
export const DEFAULT_MAX_OUTPUT_BYTES = 10_240;

/**
 * Tronque `text` à `maxBytes` octets UTF-8 (sans couper un caractère) et ajoute
 * une mention explicite pour le modèle.
 */
export function truncateOutput(
  text: string,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let cut = buf.subarray(0, maxBytes).toString('utf8');
  // Retire un éventuel caractère de remplacement final (coupure au milieu d'un caractère).
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return {
    text: `${cut}\n[… sortie tronquée : ${buf.byteLength - maxBytes} octets omis]`,
    truncated: true,
  };
}

/** Compte les occurrences (non chevauchantes) de `needle` dans `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
