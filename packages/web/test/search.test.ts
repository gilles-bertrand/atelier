import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SearchProvider } from '@atelier/shared';
import {
  BRAVE_SEARCH_URL,
  BraveSearchProvider,
  OLLAMA_SEARCH_URL,
  OllamaSearchProvider,
  SearxngProvider,
  createSearchProvider,
  webSearchTool,
} from '../src/index.js';
import { makeContext } from './helpers.js';

const SEARXNG = 'http://127.0.0.1:8888';
const requests: { url: string; headers: Headers; body?: unknown }[] = [];

const server = setupServer(
  http.get(`${SEARXNG}/search`, ({ request }) => {
    requests.push({ url: request.url, headers: request.headers });
    return HttpResponse.json({
      query: 'node lts',
      results: [
        {
          title: 'Node.js — Releases',
          url: 'https://nodejs.org/en/about/previous-releases',
          content: 'Node.js <b>24</b> is LTS',
        },
        { title: 'Doublon', url: 'https://nodejs.org/en/about/previous-releases', content: 'x' },
        { title: 'Script', url: 'javascript:alert(1)', content: 'refusé' },
        {
          title: 'Wikipedia',
          url: 'https://fr.wikipedia.org/wiki/Node.js',
          content: 'Environnement d&#39;exécution',
        },
        { title: 'Trois', url: 'https://example.com/3', content: '' },
      ],
    });
  }),
  http.get(`${SEARXNG}/healthz`, () => HttpResponse.text('OK')),
  http.post(OLLAMA_SEARCH_URL, async ({ request }) => {
    requests.push({ url: request.url, headers: request.headers, body: await request.json() });
    if (request.headers.get('authorization') !== 'Bearer ollama-key') {
      return new HttpResponse('unauthorized', { status: 401 });
    }
    return HttpResponse.json({
      results: [{ title: 'Ollama', url: 'https://ollama.com/blog', content: 'Web search API' }],
    });
  }),
  http.get(BRAVE_SEARCH_URL, ({ request }) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.headers.get('x-subscription-token') !== 'brave-key') {
      return new HttpResponse('forbidden', { status: 403 });
    }
    return HttpResponse.json({
      web: {
        results: [
          {
            title: 'Node.js <strong>LTS</strong>',
            url: 'https://nodejs.org/',
            description: 'La <strong>dernière</strong> LTS &amp; plus',
          },
        ],
      },
    });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  requests.length = 0;
});
afterAll(() => {
  server.close();
});

const fetchViaMsw = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init);

describe('SearxngProvider', () => {
  const provider = new SearxngProvider({ fetch: fetchViaMsw });

  it('normalise les résultats (http(s) seulement, dédoublonnés, HTML retiré)', async () => {
    const results = await provider.search('node lts', { maxResults: 5 });
    expect(results).toEqual([
      {
        title: 'Node.js — Releases',
        url: 'https://nodejs.org/en/about/previous-releases',
        snippet: 'Node.js 24 is LTS',
      },
      {
        title: 'Wikipedia',
        url: 'https://fr.wikipedia.org/wiki/Node.js',
        snippet: "Environnement d'exécution",
      },
      { title: 'Trois', url: 'https://example.com/3', snippet: '' },
    ]);
    const url = new URL(requests[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('node lts');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('respecte max_results', async () => {
    expect(await provider.search('node', { maxResults: 1 })).toHaveLength(1);
  });

  it('est disponible quand /healthz répond', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('VM pas prête → web/search_unavailable et isAvailable faux', async () => {
    server.use(http.get(`${SEARXNG}/*`, () => HttpResponse.error()));
    await expect(provider.search('x')).rejects.toMatchObject({ code: 'web/search_unavailable' });
    expect(await provider.isAvailable()).toBe(false);
  });
});

describe('OllamaSearchProvider', () => {
  it('envoie la clé en Bearer et max_results', async () => {
    const provider = new OllamaSearchProvider({
      fetch: fetchViaMsw,
      getApiKey: () => 'ollama-key',
    });
    const results = await provider.search('ollama', { maxResults: 3 });
    expect(results).toEqual([
      { title: 'Ollama', url: 'https://ollama.com/blog', snippet: 'Web search API' },
    ]);
    expect(requests[0]?.body).toEqual({ query: 'ollama', max_results: 3 });
  });

  it('clé refusée → erreur explicite', async () => {
    const provider = new OllamaSearchProvider({ fetch: fetchViaMsw, getApiKey: () => 'mauvaise' });
    await expect(provider.search('x')).rejects.toThrow(/clé d'API refusée \(HTTP 401\)/);
  });

  it('clé absente → indisponible sans requête', async () => {
    const provider = new OllamaSearchProvider({ fetch: fetchViaMsw, getApiKey: () => undefined });
    await expect(provider.search('x')).rejects.toMatchObject({ code: 'web/search_unavailable' });
    expect(await provider.isAvailable()).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe('BraveSearchProvider', () => {
  it('envoie X-Subscription-Token et nettoie les extraits', async () => {
    const provider = new BraveSearchProvider({
      fetch: fetchViaMsw,
      getApiKey: async () => Promise.resolve('brave-key'),
    });
    expect(await provider.search('node lts', { maxResults: 2 })).toEqual([
      { title: 'Node.js LTS', url: 'https://nodejs.org/', snippet: 'La dernière LTS & plus' },
    ]);
    expect(new URL(requests[0]?.url ?? '').searchParams.get('count')).toBe('2');
  });
});

describe('createSearchProvider', () => {
  it('injecte les clés par fournisseur', async () => {
    const getApiKey = (p: 'ollama' | 'brave'): string => `${p}-key`;
    expect(createSearchProvider('searxng').id).toBe('searxng');
    const brave = createSearchProvider('brave', { fetch: fetchViaMsw, getApiKey });
    expect(await brave.search('node')).toHaveLength(1);
    const ollama = createSearchProvider('ollama', { fetch: fetchViaMsw, getApiKey });
    expect(await ollama.search('node')).toHaveLength(1);
  });
});

describe('web_search', () => {
  const searxng = new SearxngProvider({ fetch: fetchViaMsw });

  it('renvoie les résultats au modèle et à l’UI, sans permission', async () => {
    const tool = webSearchTool({ provider: searxng });
    const { context, requestPermission } = makeContext();
    const out = await tool.execute({ query: 'node lts', max_results: 5 }, context);
    expect(out.ok).toBe(true);
    expect(out.content).toContain(
      '1. Node.js — Releases\n   https://nodejs.org/en/about/previous-releases',
    );
    expect(out.content).toContain('web_fetch');
    expect(out.display).toMatchObject({ type: 'web_results' });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(tool.permission).toBe('never');
  });

  it('max_results vaut 5 par défaut', () => {
    expect(webSearchTool({ provider: searxng }).inputSchema.parse({ query: 'x' })).toEqual({
      query: 'x',
      max_results: 5,
    });
  });

  it('VM pas prête et aucun repli → message « configure Brave ou Ollama »', async () => {
    server.use(http.get(`${SEARXNG}/*`, () => HttpResponse.error()));
    const { context } = makeContext();
    const out = await webSearchTool({ provider: searxng }).execute(
      { query: 'x', max_results: 5 },
      context,
    );
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/^Recherche indisponible, configure Brave ou Ollama/);
  });

  it('VM pas prête → bascule sur le repli configuré', async () => {
    server.use(http.get(`${SEARXNG}/*`, () => HttpResponse.error()));
    const brave = new BraveSearchProvider({ fetch: fetchViaMsw, getApiKey: () => 'brave-key' });
    const { context } = makeContext();
    const out = await webSearchTool({ provider: () => searxng, fallbacks: () => [brave] }).execute(
      { query: 'node', max_results: 5 },
      context,
    );
    expect(out.ok).toBe(true);
    expect(out.content).toContain('https://nodejs.org/');
  });

  it('une erreur non liée à la disponibilité n’essaie pas les replis', async () => {
    const failing: SearchProvider = {
      id: 'searxng',
      search: () => Promise.reject(new Error('boom')),
      isAvailable: () => Promise.resolve(true),
    };
    const { context } = makeContext();
    const out = await webSearchTool({ provider: failing }).execute(
      { query: 'x', max_results: 5 },
      context,
    );
    expect(out).toEqual({ ok: false, content: 'La recherche a échoué : boom' });
  });
});
