import { describe, expect, it, vi } from 'vitest';
import {
  checkServerHealth,
  fetchContextWindow,
  listModels,
  parseOllamaTags,
  testConnection,
} from '../src/index.js';

type FetchArgs = Parameters<typeof fetch>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Faux serveur : table route → réponse (404 sinon). */
function server(routes: Record<string, () => Response>) {
  return vi.fn<(...a: FetchArgs) => Promise<Response>>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const route = routes[path];
    return Promise.resolve(route ? route() : json({ detail: 'Not Found' }, 404));
  });
}

const OLLAMA = {
  '/api/tags': () =>
    json({
      models: [
        {
          name: 'qwen3.5:35b',
          size: 23_000_000_000,
          details: { family: 'qwen35moe', quantization_level: 'Q4_K_M' },
        },
        { name: 'atelier' },
      ],
    }),
  '/api/version': () => json({ version: '0.40.11' }),
  '/api/show': () => json({ parameters: 'num_ctx 65536' }),
  '/v1/models': () => json({ data: [{ id: 'qwen3.5:35b' }, { id: 'atelier' }] }),
};

const VLLM = {
  '/v1/models': () => json({ data: [{ id: 'atelier', max_model_len: 32768 }] }),
};

describe('listModels', () => {
  it('Ollama : /api/tags avec taille, famille et quantification', async () => {
    const f = server(OLLAMA);
    const list = await listModels({ baseUrl: 'https://llm/v1', token: 't', fetch: f });
    expect(list.flavor).toBe('ollama');
    expect(list.models).toEqual([
      {
        name: 'qwen3.5:35b',
        sizeBytes: 23_000_000_000,
        family: 'qwen35moe',
        quantization: 'Q4_K_M',
      },
      { name: 'atelier' },
    ]);
    expect(f.mock.calls[0]?.[0]).toBe('https://llm/api/tags');
    expect(new Headers(f.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer t');
  });

  it('vLLM : repli sur /v1/models', async () => {
    const f = server(VLLM);
    const list = await listModels({ baseUrl: 'https://llm', fetch: f });
    expect(list).toEqual({ flavor: 'openai-compatible', models: [{ name: 'atelier' }] });
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      'https://llm/api/tags',
      'https://llm/v1/models',
    ]);
  });

  it('401 → llm/unauthorized ; http public → llm/insecure_url', async () => {
    const f = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockResolvedValue(json({ error: 'unauthorized' }, 401));
    await expect(listModels({ baseUrl: 'https://llm', fetch: f })).rejects.toMatchObject({
      code: 'llm/unauthorized',
    });
    await expect(listModels({ baseUrl: 'http://example.com', fetch: f })).rejects.toMatchObject({
      code: 'llm/insecure_url',
    });
  });

  it('parseOllamaTags ignore les entrées invalides', () => {
    expect(parseOllamaTags({ models: [{}, { model: 'x' }, 3] })).toEqual([{ name: 'x' }]);
    expect(parseOllamaTags(null)).toEqual([]);
  });
});

describe('testConnection', () => {
  it('Ollama : version, modèles, contexte du modèle choisi', async () => {
    let t = 1000;
    const result = await testConnection({
      baseUrl: 'https://llm',
      model: 'qwen3.5:35b',
      fetch: server(OLLAMA),
      now: () => (t += 42),
    });
    expect(result).toMatchObject({
      ok: true,
      latencyMs: 42,
      serverVersion: '0.40.11',
      contextWindow: 65536,
    });
    expect(result.models).toHaveLength(2);
  });

  it('vLLM : pas de version, contexte = max_model_len', async () => {
    const result = await testConnection({
      baseUrl: 'https://llm',
      model: 'atelier',
      fetch: server(VLLM),
    });
    expect(result).toMatchObject({ ok: true, contextWindow: 32768, models: [{ name: 'atelier' }] });
    expect(result.serverVersion).toBeUndefined();
  });

  it('modèle absent : ok false mais liste renvoyée', async () => {
    const result = await testConnection({
      baseUrl: 'https://llm',
      model: 'nope',
      fetch: server(VLLM),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'llm/model_not_found' });
    expect(result.models).toEqual([{ name: 'atelier' }]);
  });

  it('ne lève jamais : serveur injoignable', async () => {
    const down = vi.fn<(...a: FetchArgs) => Promise<Response>>().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    const result = await testConnection({ baseUrl: 'https://llm', fetch: down });
    expect(result).toMatchObject({ ok: false, models: [], errorCode: 'llm/unreachable' });
    expect(result.errorMessage).toMatch(/injoignable/);
  });
});

describe('fetchContextWindow (repli vLLM)', () => {
  it('jeton refusé sur /v1/models → llm/unauthorized', async () => {
    const f = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockResolvedValueOnce(json({ detail: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({}, 401));
    await expect(
      fetchContextWindow({ baseUrl: 'https://llm', model: 'atelier', fetch: f }),
    ).rejects.toMatchObject({ code: 'llm/unauthorized' });
  });
});

describe('checkServerHealth', () => {
  it('connected / slow / offline', async () => {
    let t = 0;
    const fast = await checkServerHealth({
      baseUrl: 'https://llm',
      fetch: server(VLLM),
      now: () => (t += 100),
    });
    expect(fast).toMatchObject({ health: 'connected', latencyMs: 100 });
    expect(Date.parse(fast.checkedAt)).not.toBeNaN();

    t = 0;
    const slow = await checkServerHealth({
      baseUrl: 'https://llm',
      fetch: server(VLLM),
      now: () => (t += 5000),
    });
    expect(slow.health).toBe('slow');

    const off = await checkServerHealth({ baseUrl: 'https://llm', fetch: server({}) });
    expect(off).toMatchObject({ health: 'offline' });
    expect(off.latencyMs).toBeUndefined();
  });
});
