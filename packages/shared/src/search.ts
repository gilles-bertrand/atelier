/**
 * Recherche web : interface commune aux fournisseurs (SearXNG, Ollama, Brave).
 */
import type { WebSearchResult } from './messages.js';

/** Identifiant des fournisseurs de recherche supportés. */
export type SearchProviderId = 'searxng' | 'ollama' | 'brave';

/** Options d'une recherche. */
export interface SearchOptions {
  /** Nombre maximal de résultats (défaut 5). */
  maxResults?: number;
  /** Signal d'annulation. */
  signal?: AbortSignal;
}

/**
 * Fournisseur de recherche web. Rejette avec `web/search_unavailable` si le
 * service n'est pas joignable (VM non prête, clé manquante…).
 */
export interface SearchProvider {
  /** Identifiant du fournisseur. */
  readonly id: SearchProviderId;
  /** Lance une recherche et renvoie des résultats normalisés. */
  search(query: string, options?: SearchOptions): Promise<WebSearchResult[]>;
  /** Vérifie rapidement la disponibilité (pour les Réglages). */
  isAvailable(signal?: AbortSignal): Promise<boolean>;
}
