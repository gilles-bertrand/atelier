import { describe, expect, it } from 'vitest';
import type { LlmModelInfo } from '@atelier/shared';
import { canReadImages, chatModels, initialModel, isTestedModel, supportsTools } from './models';

describe('règles des modèles', () => {
  it('outils : requis, sauf capacités inconnues (vLLM)', () => {
    expect(supportsTools({ name: 'a', capabilities: ['completion', 'tools'] })).toBe(true);
    expect(supportsTools({ name: 'b', capabilities: ['completion'] })).toBe(false);
    expect(supportsTools({ name: 'c' })).toBe(true);
  });

  it('famille testée : profils connus et modèles de même famille, jamais une famille vide', () => {
    const all: LlmModelInfo[] = [
      { name: 'qwen3.5:35b', family: 'qwen35moe' },
      { name: 'atelier:latest', family: 'qwen35moe' },
      { name: 'llama3.1:8b', family: 'llama' },
      // Ollama 0.40 + MLX : famille vide dans `/api/tags`.
      { name: 'qwen3.5:9b', family: '' },
      { name: 'gemma4:12b-mlx', family: '' },
    ];
    const tested = (name: string): boolean =>
      isTestedModel(all.find((m) => m.name === name) ?? { name }, all);
    expect(tested('qwen3.5:35b')).toBe(true);
    expect(tested('qwen3.5:9b')).toBe(true);
    expect(tested('atelier:latest')).toBe(true);
    expect(tested('llama3.1:8b')).toBe(false);
    expect(tested('gemma4:12b-mlx')).toBe(false);
  });

  it('présélection : jamais un modèle sans outils', () => {
    const models: LlmModelInfo[] = [
      { name: 'llama-sans-outils', capabilities: ['completion'] },
      { name: 'mistral', capabilities: ['completion', 'tools'] },
    ];
    expect(initialModel(models, 'llama-sans-outils')).toBe('mistral');
  });

  it('embeddings écartés, même sans « embed » dans le nom', () => {
    expect(
      chatModels([{ name: 'vecteurs', capabilities: ['embedding'] }, { name: 'qwen3.5:9b' }]).map(
        (m) => m.name,
      ),
    ).toEqual(['qwen3.5:9b']);
  });

  it('images (D4) : modèle vision réglé, sinon capacité du modèle de la conversation', () => {
    const text: LlmModelInfo = { name: 'm', capabilities: ['completion', 'tools'] };
    expect(canReadImages(text, 'qwen2.5vl')).toBe(true);
    expect(canReadImages(text, undefined)).toBe(false);
    expect(canReadImages(text, '')).toBe(false);
    expect(canReadImages({ ...text, capabilities: ['vision'] }, undefined)).toBe(true);
    expect(canReadImages({ name: 'vllm' }, undefined)).toBe(true);
    expect(canReadImages(undefined, undefined)).toBeUndefined();
  });
});
