/**
 * Runtime de l'agent (fabrique `createAgentRuntime` d'agent-core) branché sur
 * la VM, le web, les skills et MCP. Recréé quand les Réglages LLM changent :
 * chaque session agent porte la génération du runtime qui l'a créée, et le
 * `ChatManager` la recrée (avec son historique) entre deux tours.
 */
import { createAgentRuntime, createLlmModels, type AgentRuntime } from '@atelier/agent-core';
import { createDocumentTools, createVisionAnalyzer } from '@atelier/documents';
import { mcpPromptSection, toolSearchTool, type McpManager } from '@atelier/mcp-bridge';
import { loadSkills } from '@atelier/skills';
import { createSearchProvider, createWebTools } from '@atelier/web';
import {
  AtelierError,
  type AnyToolDefinition,
  type AppSettings,
  type SearchProvider,
  type SearchProviderId,
  type SkillInfo,
} from '@atelier/shared';
import type { AgentSessionFactory, AgentSessionLike, NewAgentSession } from './chat-manager.js';
import type { SandboxManager } from './sandbox-manager.js';

type SecretGetter = (
  id: 'llm_token' | 'ollama_search_key' | 'brave_search_key',
) => string | undefined;

export interface AgentRuntimeHostOptions {
  settings: () => AppSettings;
  secret: SecretGetter;
  sandbox: SandboxManager;
  mcp: McpManager;
  /** Outils supplémentaires (ex. `read_file` multi-format de documents). */
  extraTools?: () => readonly AnyToolDefinition[];
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Fournisseurs de recherche suivant les Réglages (repli : ceux qui ont une clé). */
export function searchProviders(
  settings: () => AppSettings,
  secret: SecretGetter,
): { provider: () => SearchProvider; fallbacks: () => readonly SearchProvider[] } {
  const config = {
    getApiKey: (id: 'ollama' | 'brave') =>
      secret(id === 'ollama' ? 'ollama_search_key' : 'brave_search_key'),
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
    provider: () => get(settings().search.provider),
    fallbacks: () => {
      const active = settings().search.provider;
      const out: SearchProvider[] = [];
      if (active !== 'brave' && secret('brave_search_key')) out.push(get('brave'));
      if (active !== 'ollama' && secret('ollama_search_key')) out.push(get('ollama'));
      return out;
    },
  };
}

/** Héberge le runtime courant et crée les sessions agent. */
export class AgentRuntimeHost implements AgentSessionFactory {
  readonly #o: AgentRuntimeHostOptions;
  readonly #webTools: AnyToolDefinition[];
  #runtime: Promise<AgentRuntime> | undefined;
  #generation = 0;
  #skills: readonly SkillInfo[] = [];

  constructor(options: AgentRuntimeHostOptions) {
    this.#o = options;
    this.#webTools = createWebTools(searchProviders(options.settings, options.secret));
  }

  generation(): number {
    return this.#generation;
  }

  /** Les Réglages LLM ou le token ont changé : le prochain tour utilisera un nouveau runtime. */
  invalidate(): void {
    this.#runtime = undefined;
    this.#generation += 1;
  }

  /** Le serveur est revenu : relit la fenêtre de contexte si elle avait été devinée. */
  async refreshIfFallback(): Promise<void> {
    const pending = this.#runtime;
    if (!pending) return;
    try {
      const runtime = await pending;
      if (runtime.contextWindowSource === 'fallback') await runtime.refreshContextWindow();
    } catch {
      // Runtime invalide : l'erreur ressortira au prochain tour.
    }
  }

  /** Prépare un tour : dossier monté dans la VM, réseau de la session, skills relus. */
  async beforeTurn(sessionId: string, workspace: string): Promise<void> {
    const [, skills] = await Promise.all([
      this.#o.sandbox.prepareForTurn(sessionId, workspace),
      loadSkills(this.#o.settings().skillsDir, {
        onWarning: (w) => this.#o.log?.('skill ignoré', { dir: w.dir, message: w.message }),
      }),
    ]);
    this.#skills = skills;
  }

  async createSession(options: NewAgentSession): Promise<AgentSessionLike> {
    const runtime = await this.#current();
    return runtime.createSession({
      sessionId: options.sessionId,
      workspace: options.workspace,
      requestPermission: options.requestPermission,
      history: options.history,
      ...(options.lastInputTokens !== undefined
        ? { lastInputTokens: options.lastInputTokens }
        : {}),
    });
  }

  #current(): Promise<AgentRuntime> {
    if (!this.#runtime) {
      const created = this.#create();
      // Un échec (URL invalide) n'est pas mis en cache : réessayé au tour suivant.
      created.catch(() => {
        if (this.#runtime === created) this.#runtime = undefined;
      });
      this.#runtime = created;
    }
    return this.#runtime;
  }

  #create(): Promise<AgentRuntime> {
    const { baseUrl, model, thinking, numCtx, visionModel } = this.#o.settings().llm;
    if (baseUrl === '') {
      return Promise.reject(
        new AtelierError('llm/unreachable', 'Aucun serveur configuré.', {
          details: { kind: 'server_not_configured' },
        }),
      );
    }
    const token = this.#o.secret('llm_token');
    const { mcp, sandbox } = this.#o;
    // Vision : modèle principal (multimodal) ou modèle vision des Réglages, thinking coupé.
    const vision = createVisionAnalyzer({
      model: createLlmModels({
        baseUrl,
        model: visionModel ?? model,
        thinking: false,
        ...(token ? { token } : {}),
      }).fastModel,
    });
    return createAgentRuntime({
      llm: {
        baseUrl,
        model,
        thinking,
        ...(token ? { token } : {}),
        ...(numCtx !== undefined ? { numCtx } : {}),
      },
      tools: [
        ...createDocumentTools({ vision }),
        ...this.#webTools,
        ...(this.#o.extraTools?.() ?? []),
      ],
      sessionTools: (registry) => [toolSearchTool({ source: mcp, registry })],
      lazyTools: () => mcp.definitions(),
      sandbox: () => sandbox.current(),
      skills: () => this.#skills,
      extraInstructions: () => mcpPromptSection(mcp),
      ...(this.#o.log ? { log: this.#o.log } : {}),
    });
  }
}
