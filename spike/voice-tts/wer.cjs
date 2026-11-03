// WER au niveau du mot, après normalisation (minuscules, sans ponctuation, apostrophes et traits d'union = espaces).
'use strict';
function normalize(s) {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’'`\-–—]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
function wer(ref, hyp) {
  const r = normalize(ref);
  const h = normalize(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length };
}
module.exports = { wer, normalize };
