/**
 * Taux d'erreur sur les mots (WER), comme au spike S1 (ADR-004 §3.3) :
 * minuscules, ponctuation retirée, apostrophes et traits d'union comptés
 * comme des espaces, distance d'édition au niveau du mot.
 */
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’'`\-–—]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** Erreurs (substitutions, insertions, suppressions) et nombre de mots de la référence. */
export function wordErrors(
  reference: string,
  hypothesis: string,
): { errors: number; words: number } {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      row.push(Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, substitution));
    }
    previous = row;
  }
  return { errors: previous[hyp.length] ?? 0, words: ref.length };
}
