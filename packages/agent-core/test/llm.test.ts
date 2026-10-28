import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  backoffDelay,
  createDefaultRegistry,
  createLlmModels,
  createRetryingFetch,
  disableThinking,
  fetchContextWindow,
  parseNumCtx,
  toLlmError,
} from '../src/index.js';
import { collect, permissions, withTempDir } from './helpers.js';

type FetchArgs = Parameters<typeof fetch>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function netError(code: string): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('createRetryingFetch', () => {
  it('réessaie les erreurs réseau puis réussit', async () => {
    const inner = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockRejectedValueOnce(netError('ECONNREFUSED'))
      .mockRejectedValueOnce(netError('ECONNRESET'))
      .mockResolvedValueOnce(json({ ok: true }));
    const retries: unknown[] = [];
    const f = createRetryingFetch({
      fetch: inner,
      sleep: noSleep,
      onRetry: (i) => retries.push(i.attempt),
    });
    const res = await f('https://x/v1');
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(retries).toEqual([1, 2]);
  });

  it('réessaie 503 mais pas 401, et abandonne après N tentatives', async () => {
    const inner = vi.fn<(...a: FetchArgs) => Promise<Response>>().mockResolvedValue(json({}, 503));
    const f = createRetryingFetch({ fetch: inner, sleep: noSleep, retries: 2 });
    expect((await f('https://x')).status).toBe(503);
    expect(inner).toHaveBeenCalledTimes(3);

    const unauthorized = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockResolvedValue(json({}, 401));
    await createRetryingFetch({ fetch: unauthorized, sleep: noSleep })('https://x');
    expect(unauthorized).toHaveBeenCalledTimes(1);

    const down = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockRejectedValue(netError('ENOTFOUND'));
    await expect(
      createRetryingFetch({ fetch: down, sleep: noSleep, retries: 1 })('https://x'),
    ).rejects.toThrow('fetch failed');
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('backoff exponentiel plafonné', () => {
    const fixed = (): number => 0.5;
    expect([1, 2, 3, 4, 10].map((n) => backoffDelay(n, 500, 4000, fixed))).toEqual([
      500, 1000, 2000, 4000, 4000,
    ]);
  });
});

describe('toLlmError', () => {
  it('traduit une erreur réseau en llm/unreachable explicite', () => {
    const e = toLlmError(netError('ECONNREFUSED'), 'https://llm.example.com');
    expect(e.code).toBe('llm/unreachable');
    expect(e.retryable).toBe(true);
    expect(e.message).toContain('https://llm.example.com');
    expect(e.message).toContain('ECONNREFUSED');
  });
});

describe('fetchContextWindow', () => {
  it('lit num_ctx dans /api/show (Modelfile atelier)', async () => {
    const f = vi.fn<(...a: FetchArgs) => Promise<Response>>().mockResolvedValue(
      json({
        parameters: 'temperature 0.7\nnum_ctx                        32768\ntop_p 0.8',
        model_info: { 'qwen35moe.context_length': 262144 },
      }),
    );
    const info = await fetchContextWindow({
      baseUrl: 'https://llm/',
      model: 'atelier',
      token: 'tok',
      fetch: f,
    });
    expect(info).toEqual({ contextWindow: 32768, source: 'num_ctx', modelMaxContext: 262144 });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('https://llm/api/show');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('sans num_ctx : hypothèse 32k bornée par le modèle ; override prioritaire', async () => {
    const f = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockResolvedValue(json({ parameters: '', model_info: { 'llama.context_length': 8192 } }));
    expect(
      await fetchContextWindow({ baseUrl: 'http://localhost:11434', model: 'm', fetch: f }),
    ).toMatchObject({
      contextWindow: 8192,
      source: 'assumed',
    });
    expect(await fetchContextWindow({ baseUrl: 'x', model: 'm', override: 65536 })).toEqual({
      contextWindow: 65536,
      source: 'override',
    });
  });

  it('modèle absent (Ollama) vs repli vLLM (/v1/models)', async () => {
    const missing = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockResolvedValue(json({ error: "model 'nope' not found" }, 404));
    await expect(
      fetchContextWindow({ baseUrl: 'https://llm', model: 'nope', fetch: missing }),
    ).rejects.toMatchObject({
      code: 'llm/model_not_found',
    });
    const vllm = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockResolvedValueOnce(json({ detail: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ data: [{ id: 'Qwen/Qwen3.5', max_model_len: 131072 }] }));
    expect(
      await fetchContextWindow({ baseUrl: 'https://llm', model: 'Qwen/Qwen3.5', fetch: vllm }),
    ).toEqual({
      contextWindow: 131072,
      source: 'vllm',
    });
    expect(vllm.mock.calls[1]?.[0]).toBe('https://llm/v1/models');
  });

  it('401 → llm/unauthorized ; réseau → llm/unreachable', async () => {
    const f = vi.fn<(...a: FetchArgs) => Promise<Response>>().mockResolvedValue(json({}, 401));
    await expect(
      fetchContextWindow({ baseUrl: 'https://llm', model: 'm', fetch: f }),
    ).rejects.toMatchObject({
      code: 'llm/unauthorized',
    });
    const down = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockRejectedValue(netError('EHOSTUNREACH'));
    await expect(
      fetchContextWindow({ baseUrl: 'https://llm', model: 'm', fetch: down }),
    ).rejects.toMatchObject({
      code: 'llm/unreachable',
    });
  });

  it('parseNumCtx', () => {
    expect(parseNumCtx('num_ctx 4096')).toBe(4096);
    expect(parseNumCtx('stop "<|im_end|>"')).toBeUndefined();
    expect(parseNumCtx(undefined)).toBeUndefined();
  });
});

/** Réponse SSE au format OpenAI chat.completion.chunk (comme Ollama /v1). */
function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chunk(
  delta: Record<string, unknown>,
  finish: string | null = null,
  usage?: unknown,
): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'qwen3.5:35b',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

describe('createLlmModels (provider OpenAI-compatible réel, fetch simulé)', () => {
  it('refuse http:// hors localhost/Tailscale', () => {
    expect(() => createLlmModels({ baseUrl: 'http://llm.example.com', model: 'm' })).toThrow(
      /https/,
    );
    expect(() =>
      createLlmModels({ baseUrl: 'http://100.101.1.2:11434', model: 'm' }),
    ).not.toThrow();
  });

  it('envoie le Bearer, mappe le raisonnement Ollama (delta.reasoning) et coupe le thinking sur demande', async () => {
    await withTempDir(async (ws) => {
      const bodies: Record<string, unknown>[] = [];
      const headers: Headers[] = [];
      const fakeFetch = vi.fn((_url: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
        bodies.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
        );
        headers.push(new Headers(init?.headers));
        return Promise.resolve(
          sse([
            chunk({ role: 'assistant', reasoning: 'Réfléchissons…' }),
            chunk({ content: 'Bonjour ' }),
            chunk({ content: '!' }),
            chunk({}, 'stop', { prompt_tokens: 1234, completion_tokens: 5, total_tokens: 1239 }),
          ]),
        );
      });
      const { model, fastModel, apiBaseUrl } = createLlmModels({
        baseUrl: 'https://llm.example.com',
        model: 'qwen3.5:35b',
        token: 'secret',
        thinking: true,
        fetch: fakeFetch,
      });
      expect(apiBaseUrl).toBe('https://llm.example.com/v1');
      const agent = new Agent({
        model,
        fastModel,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 32768,
      });
      const { events, emit } = collect();
      const result = await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Salut',
        emit,
      });
      expect(fakeFetch.mock.calls[0]?.[0]).toBe('https://llm.example.com/v1/chat/completions');
      expect(headers[0]?.get('authorization')).toBe('Bearer secret');
      expect(bodies[0]?.['model']).toBe('qwen3.5:35b');
      expect(bodies[0]?.['reasoning_effort']).toBeUndefined();
      expect(Array.isArray(bodies[0]?.['tools'])).toBe(true);
      expect(events.filter((e) => e.type === 'reasoning_delta')).toHaveLength(1);
      expect(events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('')).toBe(
        'Bonjour !',
      );
      expect(result.usage?.inputTokens).toBe(1234);
      expect(JSON.stringify(result.messages)).not.toContain('Réfléchissons');

      // Thinking coupé : reasoning_effort none + enable_thinking false.
      const off = createLlmModels({
        baseUrl: 'https://llm.example.com',
        model: 'qwen3.5:9b',
        thinking: false,
        fetch: fakeFetch,
      });
      await new Agent({
        model: off.model,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 32768,
      }).runTurn({ sessionId: 's', turnId: 't2', history: [], input: 'Salut', emit });
      expect(bodies[1]?.['reasoning_effort']).toBe('none');
      expect(bodies[1]?.['chat_template_kwargs']).toEqual({ enable_thinking: false });
    });
  });

  it('extrait <think>…</think> laissé dans le contenu', async () => {
    await withTempDir(async (ws) => {
      const fakeFetch = (): Promise<Response> =>
        Promise.resolve(
          sse([
            chunk({ content: '<think>caché' }),
            chunk({ content: '</think>Visible.' }),
            chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
          ]),
        );
      const { model } = createLlmModels({
        baseUrl: 'http://localhost:11434',
        model: 'm',
        fetch: fakeFetch,
      });
      const { events, emit } = collect();
      await new Agent({
        model,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 32768,
      }).runTurn({ sessionId: 's', turnId: 't', history: [], input: 'x', emit });
      expect(events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('')).toBe(
        'Visible.',
      );
      expect(events.flatMap((e) => (e.type === 'reasoning_delta' ? [e.delta] : [])).join('')).toBe(
        'caché',
      );
    });
  });

  it('serveur injoignable : event error llm/unreachable après les nouvelles tentatives', async () => {
    await withTempDir(async (ws) => {
      const down = vi.fn((): Promise<Response> => Promise.reject(netError('ECONNREFUSED')));
      const { model } = createLlmModels({
        baseUrl: 'https://llm.example.com',
        model: 'm',
        fetch: down,
        retry: { retries: 2, baseDelayMs: 1 },
      });
      const { events, emit } = collect();
      const result = await new Agent({
        model,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 32768,
        serverUrl: 'https://llm.example.com',
      }).runTurn({ sessionId: 's', turnId: 't', history: [], input: 'x', emit });
      expect(down).toHaveBeenCalledTimes(3);
      expect(result.reason).toBe('error');
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        error: { code: 'llm/unreachable', retryable: true },
      });
    });
  });

  it('disableThinking conserve les chat_template_kwargs existants', () => {
    expect(disableThinking({ model: 'm', chat_template_kwargs: { foo: 1 } })).toEqual({
      model: 'm',
      reasoning_effort: 'none',
      chat_template_kwargs: { foo: 1, enable_thinking: false },
    });
  });
});
