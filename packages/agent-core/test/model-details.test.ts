/** Modèle par conversation (#13, L1) : capacités, modèles chargés, modèle non compatible, compaction anticipée. */
import type { ModelMessage } from 'ai';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  createAgentRuntime,
  createDefaultRegistry,
  describeModels,
  fetchContextWindow,
  fetchLoadedModels,
  fetchModelDetails,
  parseModelShow,
  parseOllamaPs,
  parseOllamaTags,
  toLlmError,
  unsupportedCapability,
} from '../src/index.js';
import {
  collect,
  permissions,
  promptText,
  scriptedModel,
  summaryModel,
  withTempDir,
} from './helpers.js';

type FetchArgs = Parameters<typeof fetch>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Corps JSON d'une requête de test (toujours une chaîne ici). */
function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

function pathOf(input: FetchArgs[0]): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(url).pathname;
}

/** Faux serveur : table route → réponse (404 sinon). */
function server(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  return vi.fn<(...a: FetchArgs) => Promise<Response>>(async (input, init) => {
    const route = routes[pathOf(input)];
    return route ? route(init) : json({ detail: 'Not Found' }, 404);
  });
}

/** Réponse `/api/show` d'Ollama 0.40 (extrait). */
const SHOW_QWEN = {
  parameters: 'num_ctx 65536\ntemperature 1',
  model_info: { 'qwen3_5_moe.context_length': 262_144 },
  capabilities: ['completion', 'vision', 'thinking', 'tools', 'audio', 'tools'],
};

describe('parseModelShow', () => {
  it('avec capacités : ne garde que les capacités connues, sans doublon', () => {
    expect(parseModelShow(SHOW_QWEN)).toEqual({
      contextWindow: 65_536,
      source: 'num_ctx',
      modelMaxContext: 262_144,
      capabilities: ['completion', 'tools', 'vision', 'thinking'],
    });
  });

  it('sans capacités (Ollama ancien) : champ absent, contexte supposé', () => {
    const details = parseModelShow({ model_info: { 'llama.context_length': 8192 } });
    expect(details).toEqual({ contextWindow: 8192, source: 'assumed', modelMaxContext: 8192 });
    expect('capabilities' in details).toBe(false);
  });

  it('capacités vides : liste vide (connue), pas absente', () => {
    expect(parseModelShow({ capabilities: [] }).capabilities).toEqual([]);
  });

  it('lit la famille dans details.family ; vide, elle reste inconnue', () => {
    expect(parseModelShow({ ...SHOW_QWEN, details: { family: 'qwen3_5_moe' } }).family).toBe(
      'qwen3_5_moe',
    );
    expect(parseModelShow({ details: { family: '' } })).not.toHaveProperty('family');
  });
});

describe('fetchModelDetails', () => {
  it('Ollama : un seul POST /api/show pour les capacités et le contexte', async () => {
    const f = server({ '/api/show': () => json(SHOW_QWEN) });
    const details = await fetchModelDetails({ baseUrl: 'https://llm/v1', model: 'q', fetch: f });
    expect(details.capabilities).toEqual(['completion', 'tools', 'vision', 'thinking']);
    expect(details.contextWindow).toBe(65_536);
    expect(f).toHaveBeenCalledTimes(1);
    expect(bodyOf(f.mock.calls[0]?.[1])).toEqual({ model: 'q' });
  });

  it('vLLM : pas de capacités, contexte lu via max_model_len', async () => {
    const f = server({
      '/v1/models': () => json({ data: [{ id: 'atelier', max_model_len: 40_960 }] }),
    });
    expect(await fetchModelDetails({ baseUrl: 'https://llm', model: 'atelier', fetch: f })).toEqual(
      { contextWindow: 40_960, source: 'vllm' },
    );
  });

  it('fetchContextWindow garde sa réponse (sans capacités)', async () => {
    const f = server({ '/api/show': () => json(SHOW_QWEN) });
    expect(await fetchContextWindow({ baseUrl: 'https://llm', model: 'q', fetch: f })).toEqual({
      contextWindow: 65_536,
      source: 'num_ctx',
      modelMaxContext: 262_144,
    });
  });
});

describe('modèles chargés (/api/ps)', () => {
  it('parseOllamaPs : noms des modèles en mémoire', () => {
    expect(
      parseOllamaPs({
        models: [{ name: 'qwen3.5:35b', model: 'qwen3.5:35b', context_length: 65_536 }],
      }),
    ).toEqual(['qwen3.5:35b']);
    expect(parseOllamaPs({ models: [] })).toEqual([]);
    expect(parseOllamaPs({})).toEqual([]);
  });

  it('fetchLoadedModels : liste sur Ollama, undefined sur vLLM (404), sans exception', async () => {
    const ollama = server({ '/api/ps': () => json({ models: [{ name: 'atelier:latest' }] }) });
    expect(await fetchLoadedModels({ baseUrl: 'https://llm', fetch: ollama })).toEqual([
      'atelier:latest',
    ]);
    expect(await fetchLoadedModels({ baseUrl: 'https://llm', fetch: server({}) })).toBeUndefined();
  });
});

describe('describeModels', () => {
  it('parseOllamaTags lit les capacités d’Ollama récent', () => {
    expect(
      parseOllamaTags({ models: [{ name: 'e', capabilities: ['embedding'] }, { name: 'x' }] }),
    ).toEqual([{ name: 'e', capabilities: ['embedding'] }, { name: 'x' }]);
  });

  it('famille vide dans /api/tags (MLX, Ollama 0.40) : absente, puis complétée par /api/show', async () => {
    const tags = parseOllamaTags({
      models: [
        { name: 'atelier:latest', details: { family: '' } },
        { name: 'llama3.1:8b', details: { family: 'llama' } },
      ],
    });
    expect(tags).toEqual([{ name: 'atelier:latest' }, { name: 'llama3.1:8b', family: 'llama' }]);
    const f = server({
      '/api/show': (init) => {
        const { model } = bodyOf(init) as { model: string };
        const family = model === 'atelier:latest' ? 'qwen3_5_moe' : 'autre';
        return json({ parameters: 'num_ctx 32768', details: { family } });
      },
    });
    const models = await describeModels(tags, { baseUrl: 'https://llm', fetch: f });
    // Une famille donnée par /api/tags garde la priorité.
    expect(models.map((m) => m.family)).toEqual(['qwen3_5_moe', 'llama']);
  });

  it('enrichit chaque modèle ; un échec laisse ses champs absents', async () => {
    const f = server({
      '/api/ps': () => json({ models: [{ name: 'a' }] }),
      '/api/show': (init) => {
        const { model } = bodyOf(init) as { model: string };
        if (model === 'cassé') return json({ error: 'boom' }, 500);
        return json({
          parameters: 'num_ctx 32768',
          capabilities: model === 'b' ? ['completion'] : ['completion', 'tools'],
        });
      },
    });
    const models = await describeModels([{ name: 'a' }, { name: 'b' }, { name: 'cassé' }], {
      baseUrl: 'https://llm',
      fetch: f,
    });
    expect(models).toEqual([
      { name: 'a', capabilities: ['completion', 'tools'], contextWindow: 32_768, loaded: true },
      { name: 'b', capabilities: ['completion'], contextWindow: 32_768, loaded: false },
      { name: 'cassé', loaded: false },
    ]);
  });

  it('concurrence bornée à 4 requêtes /api/show', async () => {
    let inFlight = 0;
    let peak = 0;
    const f = server({
      '/api/ps': () => json({ models: [] }),
      '/api/show': async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return json({ capabilities: ['completion', 'tools'] });
      },
    });
    const names = Array.from({ length: 10 }, (_, i) => ({ name: `m${String(i)}` }));
    const models = await describeModels(names, { baseUrl: 'https://llm', fetch: f });
    expect(peak).toBe(4);
    expect(models.every((m) => m.capabilities?.includes('tools') === true)).toBe(true);
  });

  it('vLLM : contexte seul, capacités et état chargé inconnus', async () => {
    const f = server({
      '/v1/models': () => json({ data: [{ id: 'atelier', max_model_len: 32_768 }] }),
    });
    expect(
      await describeModels([{ name: 'atelier' }], { baseUrl: 'https://llm', fetch: f }),
    ).toEqual([{ name: 'atelier', contextWindow: 32_768 }]);
  });
});

/** HTTP 400 d'Ollama 0.40.12 (`/v1/chat/completions`), message relevé sur un vrai serveur. */
function ollama400(capability: string): APICallError {
  const message = `hf.co/bartowski/model:Q4_K_M does not support ${capability}`;
  return new APICallError({
    message,
    url: 'https://llm/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({ error: { message, type: 'invalid_request_error' } }),
    isRetryable: false,
  });
}

describe('modèle non compatible', () => {
  it('unsupportedCapability reconnaît les capacités connues seulement', () => {
    expect(unsupportedCapability('"m" does not support tools')).toBe('tools');
    expect(unsupportedCapability('"m" does not support Thinking')).toBe('thinking');
    expect(unsupportedCapability('"m" does not support insert')).toBeUndefined();
    expect(unsupportedCapability('bad request')).toBeUndefined();
  });

  it('400 « does not support tools » → llm/model_unsupported, non relançable', () => {
    const error = toLlmError(ollama400('tools'), 'https://llm');
    expect(error.code).toBe('llm/model_unsupported');
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ missing: 'tools', status: 400 });
    expect(error.message).toContain('les outils');
  });

  it('autre 400 : llm/bad_response inchangé', () => {
    const other = new APICallError({
      message: 'invalid message format',
      url: 'https://llm/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
    });
    expect(toLlmError(other).code).toBe('llm/bad_response');
  });

  it('erreur de tour : l’agent renvoie llm/model_unsupported', async () => {
    await withTempDir(async (ws) => {
      const model = new MockLanguageModelV4({
        doStream: () => Promise.reject(ollama400('tools')),
      });
      const agent = new Agent({
        model,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 32_768,
      });
      const { events, emit } = collect();
      const result = await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Bonjour',
        emit,
      });
      expect(result.reason).toBe('error');
      expect(result.error).toMatchObject({
        code: 'llm/model_unsupported',
        details: { missing: 'tools' },
        retryable: false,
      });
      expect(events.find((e) => e.type === 'error')).toBeDefined();
    });
  });
});

describe('compaction anticipée (risque n° 3 de #13)', () => {
  /** Tour précédent terminé, avec un gros résultat d'outil (≈ 25 000 tokens). */
  const history: ModelMessage[] = [
    { role: 'user', content: 'Lis le rapport.' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'r1', toolName: 'read_file', input: { path: 'r.txt' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'r1',
          toolName: 'read_file',
          output: { type: 'text', value: 'ligne du rapport annuel\n'.repeat(4_000) },
        },
      ],
    },
    { role: 'assistant', content: 'Le rapport fait 4 000 lignes.' },
  ];

  async function firstTurn(numCtx: number) {
    const fetch = vi.fn<(...a: FetchArgs) => Promise<Response>>(() =>
      Promise.resolve(json({ parameters: `num_ctx ${String(numCtx)}` })),
    );
    const model = scriptedModel([{ text: 'Voilà.' }]);
    const runtime = await createAgentRuntime({
      llm: { baseUrl: 'https://llm.example.com', model: 'petit', fetch },
      models: { model, fastModel: summaryModel('Résumé du rapport.') },
    });
    return withTempDir(async (ws) => {
      // Session recréée sur le nouveau modèle : l'historique et la consommation suivent.
      const session = runtime.createSession({
        sessionId: 's',
        workspace: ws,
        requestPermission: permissions(),
        history,
        lastInputTokens: 30_000,
      });
      const { events, emit } = collect();
      await session.send('Et la conclusion ?', emit);
      return { events, prompt: promptText(model, 0) };
    });
  }

  it('fenêtre plus petite : compacte avant le premier appel au modèle', async () => {
    // 30 000 > 75 % de 32 768, mais < 75 % de 65 536.
    const { events, prompt } = await firstTurn(32_768);
    const types = events.map((e) => e.type);
    expect(types).toContain('compaction');
    expect(types.indexOf('compaction')).toBeLessThan(types.indexOf('usage'));
    // Le gros résultat du tour précédent n'est plus envoyé tel quel.
    expect(prompt.split('ligne du rapport annuel').length).toBeLessThan(100);
  });

  it('même consommation, grande fenêtre : pas de compaction', async () => {
    const { events, prompt } = await firstTurn(65_536);
    expect(events.some((e) => e.type === 'compaction')).toBe(false);
    expect(prompt.split('ligne du rapport annuel')).toHaveLength(4_001);
  });
});
