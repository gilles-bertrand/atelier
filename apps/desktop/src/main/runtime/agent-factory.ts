/**
 * Assemblage de l'agent (agent-core) avec la VM, le web, les skills et MCP.
 *
 * ⚠️ Assemblage local en attendant la fabrique d'agent-core (agent Core) : la
 * bascule doit se résumer à remplacer `createTurnRunner` par cette fabrique.
 */
import {
  Agent,
  createDefaultRegistry,
  createLlmModels,
  fetchContextWindow,
} from '@atelier/agent-core';
import { mcpPromptSection, toolSearchTool, type McpManager } from '@atelier/mcp-bridge';
import { loadSkills } from '@atelier/skills';
import { createSearchProvider, createWebTools } from '@atelier/web';
import {
  AtelierError,
  checkServerUrl,
  type AnyToolDefinition,
  type AppSettings,
  type SearchProvider,
  type SearchProviderId,
  type ToolRegistry,
} from '@atelier/shared';
import type { RunnerContext, TurnRunner } from './chat-manager.js';
import type { SandboxManager } from './sandbox-manager.js';

export interface AgentFactoryOptions {
  settings: () => AppSettings;
  secret: (id: 'llm_token' | 'ollama_search_key' | 'brave_search_key') => string | undefined;
  sandbox: SandboxManager;
  mcp: McpManager;
  /** Outils supplémentaires (ex. `read_file` multi-format de documents). */
  extraTools?: () => readonly AnyToolDefinition[];
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Fournisseurs de recherche suivant les Réglages (repli : ceux qui ont une clé). */
function searchProviders(o: AgentFactoryOptions): {
  provider: () => SearchProvider;
  fallbacks: () => readonly SearchProvider[];
} {
  const config = {
    getApiKey: (id: 'ollama' | 'brave') =>
      o.secret(id === 'ollama' ? 'ollama_search_key' : 'brave_search_key'),
  };
  const cache = new Map<SearchProviderId, SearchProvider>();
  const get = (id: SearchProviderId): SearchProvider => {
    let provider = cache.get(id);
    if (!provider) {
      provider = createSearchProvider(id, config);
      cache.set(id, provider);
    }
    return provider;
  };
  return {
    provider: () => get(o.settings().search.provider),
    fallbacks: () => {
      const active = o.settings().search.provider;
      const out: SearchProvider[] = [];
      if (active !== 'brave' && o.secret('brave_search_key')) out.push(get('brave'));
      if (active !== 'ollama' && o.secret('ollama_search_key')) out.push(get('ollama'));
      return out;
    },
  };
}

export class AgentFactory {
  readonly #o: AgentFactoryOptions;
  readonly #webTools: AnyToolDefinition[];
  /** Fenêtre de contexte par `url|modèle|override`. */
  readonly #contextCache = new Map<string, number>();

  constructor(options: AgentFactoryOptions) {
    this.#o = options;
    this.#webTools = createWebTools(searchProviders(options));
  }

  /** Registre d'une nouvelle session : natifs + web (+ documents) + `tool_search`. */
  createRegistry(): ToolRegistry {
    const registry = createDefaultRegistry([...this.#webTools, ...(this.#o.extraTools?.() ?? [])]);
    registry.register(toolSearchTool({ source: this.#o.mcp, registry }));
    return registry;
  }

  /** Oublie les fenêtres de contexte (changement de serveur ou de modèle). */
  invalidate(): void {
    this.#contextCache.clear();
  }

  /** Agent d'un tour : réglages, VM et skills lus maintenant. */
  async createTurnRunner(context: RunnerContext): Promise<TurnRunner> {
    const settings = this.#o.settings();
    const { baseUrl, model, thinking, numCtx } = settings.llm;
    if (baseUrl === '') {
      throw new AtelierError('llm/unreachable', 'Aucun serveur configuré.', {
        details: { kind: 'server_not_configured' },
      });
    }
    if (!checkServerUrl(baseUrl).ok) {
      throw new AtelierError('llm/insecure_url', `URL refusée : ${baseUrl}`);
    }
    const token = this.#o.secret('llm_token');
    const llm = createLlmModels({ baseUrl, model, thinking, ...(token ? { token } : {}) });

    const [contextWindow, sandbox, skills] = await Promise.all([
      this.#contextWindow(baseUrl, model, token, numCtx, context.signal),
      this.#o.sandbox.prepareForTurn(context.sessionId, context.workspace),
      loadSkills(settings.skillsDir, {
        onWarning: (w) => this.#o.log?.('skill ignoré', { dir: w.dir, message: w.message }),
      }),
    ]);

    return new Agent({
      model: llm.model,
      fastModel: llm.fastModel,
      registry: context.registry,
      workspace: context.workspace,
      requestPermission: context.requestPermission,
      ...(sandbox ? { sandbox } : {}),
      contextWindow,
      skills,
      extraInstructions: mcpPromptSection(this.#o.mcp),
      serverUrl: baseUrl,
      ...(this.#o.log ? { log: this.#o.log } : {}),
    });
  }

  async #contextWindow(
    baseUrl: string,
    model: string,
    token: string | undefined,
    override: number | undefined,
    signal: AbortSignal,
  ): Promise<number> {
    const key = `${baseUrl}|${model}|${String(override ?? '')}`;
    const cached = this.#contextCache.get(key);
    if (cached !== undefined) return cached;
    const info = await fetchContextWindow({
      baseUrl,
      model,
      signal,
      ...(token ? { token } : {}),
      ...(override !== undefined ? { override } : {}),
    });
    this.#contextCache.set(key, info.contextWindow);
    return info.contextWindow;
  }
}
