import { describe, expect, it } from 'vitest';
import { normalizeWords, wordErrors } from '../e2e/support/wer.js';

describe('wordErrors', () => {
  it('ignore la casse, la ponctuation, les apostrophes et les traits d’union', () => {
    expect(normalizeWords('Peux-tu relire l’offre ?')).toEqual([
      'peux',
      'tu',
      'relire',
      'l',
      'offre',
    ]);
    expect(wordErrors('Peux-tu relire l’offre ?', 'peux tu relire l offre')).toEqual({
      errors: 0,
      words: 5,
    });
  });

  it('compte substitutions, insertions et suppressions', () => {
    expect(wordErrors('lance la VM Lima', 'lance une VM')).toEqual({ errors: 2, words: 4 });
    expect(wordErrors('bonjour', 'bonjour à tous')).toEqual({ errors: 2, words: 1 });
    expect(wordErrors('un deux trois', '')).toEqual({ errors: 3, words: 3 });
  });
});
