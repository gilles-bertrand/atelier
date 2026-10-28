/**
 * Fournisseurs de recherche web ({@link SearchProvider}) : SearXNG (défaut,
 * servi par la VM Lima), Ollama Web Search API et Brave Search API.
 *
 * Les clés ne sont jamais stockées ici : l'app les injecte via `getApiKey`
 * (lu depuis `safeStorage` à chaque recherche, donc toujours à jour).
 */
import {
  AtelierError,
  isAtelierError,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderId,
  type WebSearchResult,
} from '@atelier/shared';
import { errorMessage, stripHtml } from '../text.js';

/** `fetch` minimal accepté (global par défaut, mock en test). */
export type SearchFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Fournit une clé d'API (ou `undefined` si non configurée). */
export type ApiKeyGetter = () => string | undefined | Promise<string | undefined>;

/** Options communes aux fournisseurs. */
export interface ProviderOptions {
  /** `fetch` injecté (défaut : `globalThis.fetch`). */
  fetch?: SearchFetch;
  /** Délai d'une recherche en millisecondes (défaut 15 s). */
  timeoutMs?: number;
}

/** URL par défaut de SearXNG (port forwardé par Lima). */
export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';
/** Endpoint de l'Ollama Web Search API. */
export const OLLAMA_SEARCH_URL = 'https://ollama.com/api/web_search';
/** Endpoint de la Brave Search API. */
export const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

const DEFAULT_TIMEOUT_MS = 15_000;
const AVAILABILITY_TIMEOUT_MS = 2_000;
/** Bornes de `max_results` (Brave et Ollama plafonnent respectivement à 20 et 10). */
export const MAX_RESULTS_LIMIT = 10;

/** Message affiché au modèle quand aucun fournisseur n'est joignable. */
export const SEARCH_UNAVAILABLE_HINT =
  "Recherche indisponible, configure Brave ou Ollama dans les Réglages d'Atelier (Recherche web).";

function clampResults(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 5;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.trunc(n)));
}

function timeoutSignal(options: ProviderOptions, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalise une liste brute en résultats valides (URL http(s), dédoublonnés). */
export function normalizeResults(
  items: unknown,
  pick: (item: Record<string, unknown>) => { title: string; url: string; snippet: string },
  max: number,
): WebSearchResult[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const { title, url, snippet } = pick(item);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: stripHtml(title) || url, url, snippet: stripHtml(snippet) });
    if (out.length >= max) break;
  }
  return out;
}

/** Exécute une requête JSON et traduit les échecs en `web/search_unavailable`. */
async function requestJson(
  provider: string,
  fetchImpl: SearchFetch,
  url: string,
  init: RequestInit,
  external: AbortSignal | undefined,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (external?.aborted) throw error;
    throw new AtelierError(
      'web/search_unavailable',
      `${provider} injoignable : ${errorMessage(error)}`,
      {
        retryable: true,
        cause: error,
      },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new AtelierError(
      'web/search_unavailable',
      `${provider} : clé d'API refusée (HTTP ${response.status}).`,
      {
        details: { provider, status: response.status },
      },
    );
  }
  if (!response.ok) {
    throw new AtelierError(
      'web/search_unavailable',
      `${provider} a répondu HTTP ${response.status}.`,
      {
        retryable: response.status === 429 || response.status >= 500,
        details: { provider, status: response.status },
      },
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new AtelierError('web/search_unavailable', `${provider} : réponse illisible.`, {
      cause: error,
    });
  }
}

async function requireKey(provider: string, getApiKey: ApiKeyGetter): Promise<string> {
  const key = (await getApiKey())?.trim();
  if (!key) {
    throw new AtelierError('web/search_unavailable', `${provider} : clé d'API non configurée.`, {
      details: { provider, missingKey: true },
    });
  }
  return key;
}

/** Options de {@link SearxngProvider}. */
export interface SearxngOptions extends ProviderOptions {
  /** URL de base (défaut {@link DEFAULT_SEARXNG_URL}). */
  baseUrl?: string;
}

/** SearXNG installé dans la VM Lima (`GET /search?q=…&format=json`). */
export class SearxngProvider implements SearchProvider {
  readonly id = 'searxng' as const;
  readonly #options: SearxngOptions;
  readonly #fetch: SearchFetch;

  constructor(options: SearxngOptions = {}) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get baseUrl(): string {
    return (this.#options.baseUrl ?? DEFAULT_SEARXNG_URL).replace(/\/+$/, '');
  }

  async search(query: string, options: SearchOptions = {}): Promise<WebSearchResult[]> {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '1');
    const data = await requestJson(
      'SearXNG',
      this.#fetch,
      url.href,
      {
        headers: { accept: 'application/json' },
        signal: timeoutSignal(this.#options, options.signal),
      },
      options.signal,
    );
    return normalizeResults(
      isRecord(data) ? data.results : undefined,
      (r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) }),
      clampResults(options.maxResults),
    );
  }

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS);
    try {
      const response = await this.#fetch(`${this.baseUrl}/healthz`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }
}

/** Options des fournisseurs à clé. */
export interface KeyedProviderOptions extends ProviderOptions {
  /** Clé d'API, lue à chaque recherche. */
  getApiKey: ApiKeyGetter;
  /** Endpoint (surcharge pour les tests ou un proxy). */
  endpoint?: string;
}

/** Ollama Web Search API (`POST /api/web_search`, `Authorization: Bearer`). */
export class OllamaSearchProvider implements SearchProvider {
  readonly id = 'ollama' as const;
  readonly #options: KeyedProviderOptions;
  readonly #fetch: SearchFetch;

  constructor(options: KeyedProviderOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async search(query: string, options: SearchOptions = {}): Promise<WebSearchResult[]> {
    const key = await requireKey('Ollama Web Search', this.#options.getApiKey);
    const max = clampResults(options.maxResults);
    const data = await requestJson(
      'Ollama Web Search',
      this.#fetch,
      this.#options.endpoint ?? OLLAMA_SEARCH_URL,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, max_results: max }),
        signal: timeoutSignal(this.#options, options.signal),
      },
      options.signal,
    );
    return normalizeResults(
      isRecord(data) ? data.results : undefined,
      (r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content).slice(0, 500) }),
      max,
    );
  }

  async isAvailable(): Promise<boolean> {
    return Boolean((await this.#options.getApiKey())?.trim());
  }
}

/** Brave Search API (`GET /res/v1/web/search`, en-tête `X-Subscription-Token`). */
export class BraveSearchProvider implements SearchProvider {
  readonly id = 'brave' as const;
  readonly #options: KeyedProviderOptions;
  readonly #fetch: SearchFetch;

  constructor(options: KeyedProviderOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async search(query: string, options: SearchOptions = {}): Promise<WebSearchResult[]> {
    const key = await requireKey('Brave Search', this.#options.getApiKey);
    const max = clampResults(options.maxResults);
    const url = new URL(this.#options.endpoint ?? BRAVE_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(max));
    const data = await requestJson(
      'Brave Search',
      this.#fetch,
      url.href,
      {
        headers: { accept: 'application/json', 'x-subscription-token': key },
        signal: timeoutSignal(this.#options, options.signal),
      },
      options.signal,
    );
    const web = isRecord(data) && isRecord(data.web) ? data.web : undefined;
    return normalizeResults(
      web?.results,
      (r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.description) }),
      max,
    );
  }

  async isAvailable(): Promise<boolean> {
    return Boolean((await this.#options.getApiKey())?.trim());
  }
}

/** Configuration de {@link createSearchProvider}. */
export interface SearchProviderConfig extends ProviderOptions {
  /** URL de SearXNG (défaut {@link DEFAULT_SEARXNG_URL}). */
  searxngUrl?: string;
  /** Clés injectées par l'app (lues via `safeStorage`). */
  getApiKey?: (provider: 'ollama' | 'brave') => string | undefined | Promise<string | undefined>;
}

/** Instancie le fournisseur choisi dans les Réglages. */
export function createSearchProvider(
  id: SearchProviderId,
  config: SearchProviderConfig = {},
): SearchProvider {
  const base: ProviderOptions = {
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  };
  const keyFor =
    (provider: 'ollama' | 'brave'): ApiKeyGetter =>
    () =>
      config.getApiKey?.(provider);
  switch (id) {
    case 'searxng':
      return new SearxngProvider({
        ...base,
        ...(config.searxngUrl ? { baseUrl: config.searxngUrl } : {}),
      });
    case 'ollama':
      return new OllamaSearchProvider({ ...base, getApiKey: keyFor('ollama') });
    case 'brave':
      return new BraveSearchProvider({ ...base, getApiKey: keyFor('brave') });
  }
}

/** Vrai si l'erreur signale un fournisseur indisponible (VM non prête, clé absente…). */
export function isSearchUnavailable(error: unknown): boolean {
  return isAtelierError(error) && error.code === 'web/search_unavailable';
}
