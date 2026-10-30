import { describe, expect, it } from 'vitest';
import { modelKey, sameModel } from './model-name.js';

describe('noms de modèle', () => {
  it('« x » et « x:latest » désignent le même modèle, les autres étiquettes non', () => {
    expect(modelKey('atelier:latest')).toBe('atelier');
    expect(modelKey('atelier')).toBe('atelier');
    expect(modelKey('qwen3.5:35b')).toBe('qwen3.5:35b');
    expect(sameModel('atelier', 'atelier:latest')).toBe(true);
    expect(sameModel('atelier:latest', 'atelier')).toBe(true);
    expect(sameModel('qwen3.5:35b', 'qwen3.5:9b')).toBe(false);
    expect(sameModel('qwen3.5', 'qwen3.5:35b')).toBe(false);
    // Nom vLLM (sans étiquette) : comparé tel quel.
    expect(sameModel('Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B')).toBe(true);
  });

  it('un nom absent n’égale qu’un nom absent', () => {
    expect(sameModel(undefined, undefined)).toBe(true);
    expect(sameModel('atelier', undefined)).toBe(false);
    expect(sameModel(undefined, 'atelier')).toBe(false);
  });
});
