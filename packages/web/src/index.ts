/**
 * @atelier/web — `web_search` (fournisseurs SearXNG / Ollama / Brave) et
 * `web_fetch` (extraction Readability + turndown, côté hôte). Voir docs/BRIEF.md §4.
 */
import type { AnyToolDefinition } from '@atelier/shared';
import { webFetchTool, type WebFetchOptions } from './fetch/web-fetch.js';
import { webSearchTool, type WebSearchToolOptions } from './search/web-search.js';

export const PACKAGE_NAME = '@atelier/web';

export { isBlockedAddress, embeddedIpv4 } from './net/address.js';
export {
  assertPublicHost,
  createGuardedLookup,
  defaultResolveHost,
  parseFetchableUrl,
} from './net/guard.js';
export type { ResolveHost } from './net/guard.js';
export { extractHtml } from './fetch/extract.js';
export type { ExtractedPage } from './fetch/extract.js';
export {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
  PausableTimeout,
  WEB_FETCH_MAX_OUTPUT_BYTES,
  describeWebFetch,
  fetchPage,
  permissionDomain,
  webFetchTool,
} from './fetch/web-fetch.js';
export type { FetchLike, FetchedPage, WebFetchInput, WebFetchOptions } from './fetch/web-fetch.js';
export {
  BRAVE_SEARCH_URL,
  BraveSearchProvider,
  DEFAULT_SEARXNG_URL,
  MAX_RESULTS_LIMIT,
  OLLAMA_SEARCH_URL,
  OllamaSearchProvider,
  SEARCH_UNAVAILABLE_HINT,
  SearxngProvider,
  createSearchProvider,
  isSearchUnavailable,
  normalizeResults,
} from './search/providers.js';
export type {
  ApiKeyGetter,
  KeyedProviderOptions,
  ProviderOptions,
  SearchFetch,
  SearchProviderConfig,
  SearxngOptions,
} from './search/providers.js';
export { formatResults, webSearchTool } from './search/web-search.js';
export type { WebSearchInput, WebSearchToolOptions } from './search/web-search.js';
export { truncateUtf8 } from './text.js';

/** Options de {@link createWebTools}. */
export interface WebToolsOptions extends WebSearchToolOptions {
  /** Options de `web_fetch`. */
  fetch?: WebFetchOptions;
}

/** Outils web à passer à `createDefaultRegistry` (agent-core). */
export function createWebTools(options: WebToolsOptions): AnyToolDefinition[] {
  return [webSearchTool(options), webFetchTool(options.fetch)];
}
