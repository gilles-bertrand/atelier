/**
 * Catalogue des modèles du serveur (#13, L2) : liste enrichie du sélecteur
 * (`llm:list-models`), capacités pour le choix du modèle vision (D4) et
 * validation du modèle d'une conversation (`session:set-model`).
 *
 * Les détails d'un modèle (`/api/show` : capacités, fenêtre de contexte)
 * changent rarement : ils restent en cache 5 min par nom et sont oubliés quand
 * l'URL du serveur ou le jeton changent. L'état chargé (`/api/ps`) change à
 * chaque bascule du serveur : il est relu à chaque liste.
 */
import {
  DESCRIBE_CONCURRENCY,
  fetchLoadedModels,
  fetchModelDetails,
  listModels,
  type ServerQueryOptions,
} from '@atelier/agent-core';
import { AtelierError, type LlmModelInfo, type ModelCapability } from '@atelier/shared';

/** Durée de vie des détails d'un modèle en cache. */
export const MODEL_DETAILS_TTL_MS = 5 * 60_000;

/** Requêtes `/api/show` simultanées au plus pendant une liste (comme `describeModels`). */
export const MODEL_DETAILS_CONCURRENCY = DESCRIBE_CONCURRENCY;

/** Détails d'un modèle utiles à l'app. */
export interface ModelDetailsInfo {
  /** Capacités annoncées. Absent : inconnues (vLLM, Ollama ancien). */
  capabilities?: readonly ModelCapability[];
  /** Fenêtre de contexte effective. */
  contextWindow?: number;
}

/** Accès au serveur (fonctions d'agent-core), injecté pour les tests. */
export interface ModelCatalogSource {
  /** Modèles installés (`/api/tags`, repli `/v1/models`). */
  list(): Promise<LlmModelInfo[]>;
  /** Détails d'un modèle (`/api/show`). */
  details(model: string): Promise<ModelDetailsInfo>;
  /** Modèles en mémoire (`/api/ps`) ; `undefined` : inconnu (vLLM). */
  loaded(): Promise<readonly string[] | undefined>;
}

export interface ModelCatalogOptions {
  source: ModelCatalogSource;
  /** Contexte forcé dans les Réglages (`numCtx`) : c'est celui que le runtime utilisera. */
  numCtx?: () => number | undefined;
  /** Durée de vie du cache des détails (défaut {@link MODEL_DETAILS_TTL_MS}). */
  ttlMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
}

interface CachedDetails {
  at: number;
  value: Promise<ModelDetailsInfo>;
}

/**
 * Source branchée sur le serveur configuré. `server` est relu à chaque appel :
 * l'URL et le jeton peuvent changer à tout moment dans les Réglages.
 */
export function serverModelSource(server: () => ServerQueryOptions): ModelCatalogSource {
  return {
    list: async () => (await listModels(server())).models,
    details: async (model) => {
      const details = await fetchModelDetails({ ...server(), model });
      return {
        ...(details.capabilities !== undefined ? { capabilities: details.capabilities } : {}),
        contextWindow: details.contextWindow,
      };
    },
    loaded: () => fetchLoadedModels(server()),
  };
}

export class ModelCatalog {
  readonly #o: ModelCatalogOptions;
  readonly #details = new Map<string, CachedDetails>();

  constructor(options: ModelCatalogOptions) {
    this.#o = options;
  }

  /**
   * Modèles installés, enrichis de leurs capacités, de leur fenêtre de contexte
   * et de leur état chargé. Un détail illisible laisse ses champs absents
   * (inconnus) sans faire échouer la liste ; un serveur injoignable la fait échouer.
   */
  async list(): Promise<LlmModelInfo[]> {
    const [models, loaded] = await Promise.all([
      this.#o.source.list(),
      this.#o.source.loaded().catch(() => undefined),
    ]);
    const details = await mapWithLimit(models, MODEL_DETAILS_CONCURRENCY, (model) =>
      this.#detailsOf(model.name),
    );
    const numCtx = this.#o.numCtx?.();
    return models.map((model, index) => {
      const info = details[index] ?? {};
      const contextWindow = numCtx ?? info.contextWindow;
      return {
        ...model,
        ...(info.capabilities !== undefined ? { capabilities: [...info.capabilities] } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(loaded !== undefined ? { loaded: loaded.includes(model.name) } : {}),
      };
    });
  }

  /** Capacités d'un modèle ; `undefined` : inconnues (le modèle est alors permis). */
  async capabilities(model: string): Promise<readonly ModelCapability[] | undefined> {
    return (await this.#detailsOf(model)).capabilities;
  }

  /**
   * Vérifie qu'un modèle peut piloter une conversation : installé sur le
   * serveur et, si ses capacités sont connues, capable d'utiliser les outils.
   */
  async assertUsable(model: string): Promise<void> {
    const models = await this.#o.source.list();
    const installed = models.find((m) => m.name === model);
    if (!installed) {
      throw new AtelierError(
        'llm/model_not_found',
        `Le modèle « ${model} » n’est pas installé sur le serveur.`,
        { details: { model } },
      );
    }
    // Ollama récent annonce les capacités dès `/api/tags` : `/api/show` seulement à défaut.
    const capabilities = installed.capabilities ?? (await this.capabilities(model));
    if (capabilities !== undefined && !capabilities.includes('tools')) {
      throw new AtelierError(
        'llm/model_unsupported',
        `Le modèle « ${model} » ne sait pas utiliser les outils d’Atelier.`,
        { details: { model, missing: 'tools' } },
      );
    }
  }

  /** L'URL du serveur ou le jeton ont changé : les détails en cache ne valent plus. */
  clear(): void {
    this.#details.clear();
  }

  /** Détails en cache (partagés par les appels simultanés) ; un échec n'est jamais gardé. */
  #detailsOf(model: string): Promise<ModelDetailsInfo> {
    const now = (this.#o.now ?? Date.now)();
    const cached = this.#details.get(model);
    if (cached && now - cached.at < (this.#o.ttlMs ?? MODEL_DETAILS_TTL_MS)) return cached.value;
    const entry: CachedDetails = { at: now, value: Promise.resolve({}) };
    entry.value = this.#o.source.details(model).catch(() => {
      // Serveur injoignable ou réponse illisible : capacités inconnues, réessayé au prochain appel.
      if (this.#details.get(model) === entry) this.#details.delete(model);
      return {};
    });
    this.#details.set(model, entry);
    return entry.value;
  }
}

/** Applique `fn` à chaque élément, avec au plus `limit` appels en cours, dans l'ordre. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
