/**
 * `web_search` : recherche web via le {@link SearchProvider} choisi dans les
 * Réglages, sans demande de permission (brief §4).
 *
 * Si le fournisseur est indisponible (VM pas encore prête pour SearXNG, clé
 * manquante…), les fournisseurs de repli sont essayés dans l'ordre ; à défaut,
 * le modèle reçoit un message clair l'invitant à faire configurer Brave ou Ollama.
 */
import { z } from 'zod';
import {
  defineTool,
  type SearchProvider,
  type ToolDefinition,
  type ToolOutput,
  type WebSearchResult,
} from '@atelier/shared';
import { errorMessage } from '../text.js';
import { MAX_RESULTS_LIMIT, SEARCH_UNAVAILABLE_HINT, isSearchUnavailable } from './providers.js';

/** Options de {@link webSearchTool}. */
export interface WebSearchToolOptions {
  /**
   * Fournisseur actif. Une fonction permet de suivre un changement de Réglages
   * sans recréer l'outil.
   */
  provider: SearchProvider | (() => SearchProvider);
  /** Fournisseurs essayés si le principal est indisponible (ex. Brave si une clé existe). */
  fallbacks?: readonly SearchProvider[] | (() => readonly SearchProvider[]);
}

const inputSchema = z.object({
  query: z.string().trim().min(1).max(400).describe('Requête de recherche, précise et concise.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS_LIMIT)
    .default(5)
    .describe(`Nombre de résultats (1 à ${MAX_RESULTS_LIMIT}, défaut 5).`),
});

/** Entrée de `web_search`. */
export type WebSearchInput = z.infer<typeof inputSchema>;

/** Résultats au format texte pour le modèle. */
export function formatResults(query: string, results: readonly WebSearchResult[]): string {
  if (results.length === 0) return `Aucun résultat pour « ${query} ».`;
  const lines = results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
  );
  return `Résultats pour « ${query} » :\n\n${lines.join('\n\n')}\n\nLis 2-3 sources avec web_fetch et cite les URLs.`;
}

/** Crée l'outil `web_search`. */
export function webSearchTool(options: WebSearchToolOptions): ToolDefinition<WebSearchInput> {
  const primary = (): SearchProvider =>
    typeof options.provider === 'function' ? options.provider() : options.provider;
  const fallbacks = (): readonly SearchProvider[] =>
    typeof options.fallbacks === 'function' ? options.fallbacks() : (options.fallbacks ?? []);

  return defineTool({
    name: 'web_search',
    description:
      'Recherche sur le web et renvoie une liste de résultats { titre, URL, extrait }. ' +
      'À utiliser pour toute question factuelle récente, puis lire 2-3 sources avec web_fetch.',
    inputSchema,
    permission: 'never',
    source: 'web',
    async execute({ query, max_results }, context): Promise<ToolOutput> {
      const providers = [primary(), ...fallbacks().filter((p) => p.id !== primary().id)];
      const failures: string[] = [];
      for (const provider of providers) {
        try {
          const results = await provider.search(query, {
            maxResults: max_results,
            signal: context.abortSignal,
          });
          return {
            ok: true,
            content: formatResults(query, results),
            display: { type: 'web_results', results },
          };
        } catch (error) {
          if (context.abortSignal.aborted) throw error;
          failures.push(errorMessage(error));
          // Erreur autre qu'une indisponibilité : inutile d'essayer les replis.
          if (!isSearchUnavailable(error)) {
            return { ok: false, content: `La recherche a échoué : ${errorMessage(error)}` };
          }
        }
      }
      return {
        ok: false,
        content:
          `${SEARCH_UNAVAILABLE_HINT}\nDétail : ${failures.join(' ; ')}\n` +
          "Dis-le à l'utilisateur ; ne tente pas de contourner (pas de curl dans la VM).",
      };
    },
  });
}
