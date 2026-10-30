import { describe, expect, it } from 'vitest';
import type { LlmModelInfo } from '@atelier/shared';
import {
  MODEL_DETAILS_CONCURRENCY,
  MODEL_DETAILS_TTL_MS,
  ModelCatalog,
  serverModelSource,
  type ModelCatalogSource,
  type ModelDetailsInfo,
} from './model-catalog.js';

const TAGS: LlmModelInfo[] = [
  { name: 'qwen3.5:35b', sizeBytes: 24_000_000_000, family: 'qwen35moe' },
  { name: 'llama3.1:8b' },
  { name: 'nomic-embed-text' },
];

const SHOW: Record<string, ModelDetailsInfo> = {
  'qwen3.5:35b': {
    capabilities: ['completion', 'tools', 'vision', 'thinking'],
    contextWindow: 32_768,
  },
  'llama3.1:8b': { capabilities: ['completion', 'tools'], contextWindow: 8_192 },
  'nomic-embed-text': { capabilities: ['embedding'], contextWindow: 2_048 },
};

/** Serveur factice : compte les appels et la concurrence de `/api/show`. */
function setup(
  options: {
    models?: LlmModelInfo[];
    loaded?: readonly string[] | undefined;
    failing?: readonly string[];
    numCtx?: number;
  } = {},
) {
  let now = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = { details: [] as string[], loaded: 0 };
  const source: ModelCatalogSource = {
    list: () => Promise.resolve(options.models ?? TAGS),
    details: async (model) => {
      calls.details.push(model);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      if (options.failing?.includes(model)) throw new Error('réponse illisible');
      return SHOW[model] ?? {};
    },
    loaded: () => {
      calls.loaded += 1;
      return Promise.resolve('loaded' in options ? options.loaded : ['qwen3.5:35b']);
    },
  };
  const catalog = new ModelCatalog({ source, now: () => now, numCtx: () => options.numCtx });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { catalog, calls, advance, maxInFlight: () => maxInFlight };
}

describe('ModelCatalog', () => {
  it('enrichit la liste : capacités, contexte et état chargé', async () => {
    const { catalog } = setup();
    expect(await catalog.list()).toEqual([
      {
        name: 'qwen3.5:35b',
        sizeBytes: 24_000_000_000,
        family: 'qwen35moe',
        capabilities: ['completion', 'tools', 'vision', 'thinking'],
        contextWindow: 32_768,
        loaded: true,
      },
      {
        name: 'llama3.1:8b',
        capabilities: ['completion', 'tools'],
        contextWindow: 8_192,
        loaded: false,
      },
      {
        name: 'nomic-embed-text',
        capabilities: ['embedding'],
        contextWindow: 2_048,
        loaded: false,
      },
    ]);
  });

  it('garde les détails 5 min mais relit les modèles chargés à chaque liste', async () => {
    const { catalog, calls, advance } = setup();
    await catalog.list();
    await catalog.list();
    expect(calls.details).toHaveLength(3);
    expect(calls.loaded).toBe(2);
    advance(MODEL_DETAILS_TTL_MS);
    await catalog.list();
    expect(calls.details).toHaveLength(6);
    // URL ou jeton changés : le cache est vidé.
    catalog.clear();
    await catalog.capabilities('llama3.1:8b');
    expect(calls.details).toHaveLength(7);
  });

  it('partage une lecture en cours entre appels simultanés', async () => {
    const { catalog, calls } = setup();
    await Promise.all([catalog.capabilities('qwen3.5:35b'), catalog.capabilities('qwen3.5:35b')]);
    expect(calls.details).toEqual(['qwen3.5:35b']);
  });

  it('un détail illisible ou un /api/ps absent laisse les champs inconnus, sans garder l’échec', async () => {
    const { catalog, calls } = setup({ loaded: undefined, failing: ['llama3.1:8b'] });
    const [qwen, llama] = await catalog.list();
    expect(qwen).not.toHaveProperty('loaded');
    expect(llama).toEqual({ name: 'llama3.1:8b' });
    await catalog.list();
    expect(calls.details.filter((m) => m === 'llama3.1:8b')).toHaveLength(2);
  });

  it('applique le contexte forcé dans les Réglages', async () => {
    const { catalog } = setup({ numCtx: 65_536 });
    expect((await catalog.list()).map((m) => m.contextWindow)).toEqual([65_536, 65_536, 65_536]);
  });

  it(`interroge /api/show ${String(MODEL_DETAILS_CONCURRENCY)} modèles à la fois au plus, dans l'ordre`, async () => {
    const models = Array.from({ length: 10 }, (_, i) => ({ name: `m${String(i)}` }));
    const { catalog, maxInFlight } = setup({ models });
    expect((await catalog.list()).map((m) => m.name)).toEqual(models.map((m) => m.name));
    expect(maxInFlight()).toBe(MODEL_DETAILS_CONCURRENCY);
  });

  it('assertUsable : modèle absent, sans outils, ou aux capacités inconnues', async () => {
    const { catalog } = setup({ failing: ['llama3.1:8b'] });
    await expect(catalog.assertUsable('qwen3.5:35b')).resolves.toBeUndefined();
    await expect(catalog.assertUsable('mistral:7b')).rejects.toMatchObject({
      code: 'llm/model_not_found',
      details: { model: 'mistral:7b' },
    });
    await expect(catalog.assertUsable('nomic-embed-text')).rejects.toMatchObject({
      code: 'llm/model_unsupported',
      details: { model: 'nomic-embed-text', missing: 'tools' },
    });
    // Capacités illisibles : le modèle reste permis (D2).
    await expect(catalog.assertUsable('llama3.1:8b')).resolves.toBeUndefined();
  });

  it('« atelier » est installé si le serveur liste « atelier:latest », détails partagés', async () => {
    const { catalog, calls } = setup({ models: [{ name: 'atelier:latest' }] });
    await expect(catalog.assertUsable('atelier')).resolves.toBeUndefined();
    await catalog.capabilities('atelier:latest');
    expect(calls.details).toEqual(['atelier']);
  });

  it('assertUsable se fie aux capacités de /api/tags quand le serveur les donne', async () => {
    const { catalog, calls } = setup({
      models: [{ name: 'bge-m3', capabilities: ['embedding'] }],
      failing: ['bge-m3'],
    });
    await expect(catalog.assertUsable('bge-m3')).rejects.toMatchObject({
      code: 'llm/model_unsupported',
    });
    expect(calls.details).toEqual([]);
  });
});

describe('serverModelSource (fonctions d’agent-core, réponses d’Ollama 0.40)', () => {
  /** Faux serveur Ollama : `/api/tags`, `/api/show` (par modèle) et `/api/ps`. */
  const ollama = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const model = (body as { model?: string }).model;
    const reply = (value: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (pathname === '/api/tags') {
      return reply({
        models: [
          {
            name: 'qwen3.5:35b',
            model: 'qwen3.5:35b',
            size: 24_000_000_000,
            // Modèle MLX : Ollama 0.40 laisse la famille vide dans `/api/tags`.
            details: { family: '' },
            capabilities: ['completion', 'tools', 'vision'],
          },
          {
            name: 'llama3.1:8b',
            model: 'llama3.1:8b',
            size: 4_900_000_000,
            details: { family: 'llama' },
          },
        ],
      });
    }
    if (pathname === '/api/show') {
      return reply(
        model === 'qwen3.5:35b'
          ? {
              parameters: 'num_ctx 65536',
              details: { family: 'qwen3_5_moe' },
              model_info: { 'qwen3_5_moe.context_length': 262_144 },
              capabilities: ['completion', 'tools', 'vision'],
            }
          : {
              parameters: '',
              details: { family: 'autre' },
              model_info: { 'llama.context_length': 131_072 },
              capabilities: ['completion', 'tools'],
            },
      );
    }
    if (pathname === '/api/ps') {
      return reply({ models: [{ name: 'qwen3.5:35b', model: 'qwen3.5:35b' }] });
    }
    return Promise.resolve(new Response('{"detail":"Not Found"}', { status: 404 }));
  };

  it('remplit capacités, contexte, famille et état chargé depuis le serveur', async () => {
    const catalog = new ModelCatalog({
      source: serverModelSource(() => ({ baseUrl: 'https://llm.exemple.fr', fetch: ollama })),
    });
    expect(await catalog.list()).toMatchObject([
      // Famille vide dans `/api/tags` (MLX) : celle de `/api/show` la remplace.
      {
        name: 'qwen3.5:35b',
        family: 'qwen3_5_moe',
        capabilities: ['completion', 'tools', 'vision'],
        contextWindow: 65_536,
        loaded: true,
      },
      // Sans `num_ctx` : 32 768, borné par le maximum du modèle. La famille de `/api/tags` prime.
      {
        name: 'llama3.1:8b',
        family: 'llama',
        capabilities: ['completion', 'tools'],
        contextWindow: 32_768,
        loaded: false,
      },
    ]);
    await expect(catalog.assertUsable('llama3.1:8b')).resolves.toBeUndefined();
  });
});
