import { describe, expect, it, vi } from 'vitest';
import type { ServerStatus } from '@atelier/shared';
import { listModels, parseTags, testConnection, type FetchLike } from './server-api.js';
import { healthFromLatency, ServerMonitor } from './server-monitor.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Faux serveur Ollama : routes → réponses. */
function fakeOllama(
  routes: Record<string, () => Response | Promise<Response>>,
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`.trim());
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const tags = {
  models: [
    { name: 'qwen3.5:9b', size: 6e9, details: { family: 'qwen3', quantization_level: 'Q4_K_M' } },
    { name: 'qwen3.5:35b', size: 2.4e10, details: {} },
  ],
};

describe('testConnection', () => {
  it('renvoie latence, version, modèles et contexte', async () => {
    const fetchImpl = fakeOllama({
      '/api/version': () => json({ version: '0.40.11' }),
      '/api/tags': () => json(tags),
      '/api/show': () =>
        json({ parameters: 'num_ctx 65536', model_info: { 'qwen3.context_length': 262144 } }),
    });
    const result = await testConnection(
      { baseUrl: 'https://llm.example.com/', token: 'tok', model: 'qwen3.5:35b' },
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: true, serverVersion: '0.40.11', contextWindow: 65536 });
    expect(result.models.map((m) => m.name)).toEqual(['qwen3.5:35b', 'qwen3.5:9b']);
    expect(fetchImpl.calls[0]).toBe('https://llm.example.com/api/version Bearer tok');
  });

  it('refuse le http public sans appel réseau', async () => {
    const fetchImpl = fakeOllama({});
    const result = await testConnection({ baseUrl: 'http://llm.example.com' }, fetchImpl);
    expect(result).toMatchObject({ ok: false, errorCode: 'llm/insecure_url' });
    expect(fetchImpl.calls).toEqual([]);
  });

  it('traduit 401 en token refusé et une coupure en serveur injoignable', async () => {
    const unauthorized = await testConnection(
      { baseUrl: 'https://x.fr' },
      fakeOllama({ '/api/version': () => new Response('', { status: 401 }) }),
    );
    expect(unauthorized).toMatchObject({ ok: false, errorCode: 'llm/unauthorized' });
    expect(unauthorized.errorMessage).toMatch(/jeton/);
    const down = await testConnection({ baseUrl: 'https://x.fr' }, () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    expect(down).toMatchObject({ ok: false, errorCode: 'llm/unreachable' });
  });

  it('se replie sur /v1/models (vLLM)', async () => {
    const fetchImpl = fakeOllama({
      '/v1/models': () => json({ data: [{ id: 'Qwen/Qwen3.5-35B' }] }),
    });
    expect(await listModels({ baseUrl: 'https://x.fr' }, fetchImpl)).toEqual([
      { name: 'Qwen/Qwen3.5-35B' },
    ]);
  });

  it('parseTags tolère les entrées invalides', () => {
    expect(parseTags({ models: [{ name: 'a' }, 42, { nope: 1 }] })).toEqual([{ name: 'a' }]);
    expect(parseTags(null)).toEqual([]);
  });
});

describe('ServerMonitor', () => {
  it('classe la santé selon la latence', () => {
    expect(healthFromLatency(undefined)).toBe('offline');
    expect(healthFromLatency(200)).toBe('connected');
    expect(healthFromLatency(5_000)).toBe('slow');
  });

  it('notifie les changements et replanifie plus vite hors ligne', async () => {
    const changes: ServerStatus[] = [];
    const delays: number[] = [];
    let up = true;
    const monitor = new ServerMonitor({
      target: () => ({ baseUrl: 'https://x.fr' }),
      probe: () => (up ? Promise.resolve({ latencyMs: 120 }) : Promise.reject(new Error('down'))),
      onChange: (s) => changes.push(s),
      setTimer: (_fn, ms) => {
        delays.push(ms);
        return ms;
      },
      clearTimer: vi.fn(),
    });
    await monitor.check();
    up = false;
    await monitor.check();
    expect(changes.map((c) => c.health)).toEqual(['connected', 'offline']);
    expect(delays).toEqual([30_000, 10_000]);
  });

  it('reste « inconnu » sans serveur configuré', async () => {
    const probe = vi.fn();
    const monitor = new ServerMonitor({ target: () => undefined, probe, onChange: vi.fn() });
    expect((await monitor.check()).health).toBe('unknown');
    expect(probe).not.toHaveBeenCalled();
  });
});
