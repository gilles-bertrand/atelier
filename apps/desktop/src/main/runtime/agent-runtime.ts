/**
 * Runtimes de l'agent (fabrique `createAgentRuntime` d'agent-core) branchés sur
 * la VM, le web, les skills et MCP. Un runtime par modèle (#13) : chacun lit la
 * fenêtre de contexte de son modèle et choisit sa vision (D4). Ils sont recréés
 * quand les Réglages LLM changent : chaque session agent porte la génération
 * qui l'a créée, et le `ChatManager` la recrée (avec son historique) entre
 * deux tours.
 */
import {
  createAgentRuntime,
  createLlmModels,
  skillReadRoots,
  type AgentRuntime,
} from '@atelier/agent-core';
import {
  createDocumentTools,
  createVisionAnalyzer,
  outputTokensForContext,
} from '@atelier/documents';
import { mcpPromptSection, toolSearchTool, type McpManager } from '@atelier/mcp-bridge';
import { loadSkills } from '@atelier/skills';
import { createSearchProvider, createWebTools } from '@atelier/web';
import {
  AtelierError,
  type AnyToolDefinition,
  type AppSettings,
  type ModelCapability,
  type SandboxFolderMount,
  type SearchProvider,
  type SearchProviderId,
  type SkillInfo,
} from '@atelier/shared';
import { modelKey } from '../../common/model-name.js';
import type { AgentSessionFactory, AgentSessionLike, NewAgentSession } from './chat-manager.js';
import type { SandboxManager } from './sandbox-manager.js';

/** Fenêtre supposée avant que le runtime ait lu celle du serveur (plancher d'agent-core). */
const FALLBACK_CONTEXT_WINDOW = 32_768;

/** Runtimes gardés en cache (les modèles les plus récemment utilisés). */
export const MAX_RUNTIMES = 3;

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
  /** Capacités d'un modèle (choix de la vision, D4) ; `undefined` : inconnues. */
  capabilities?: (model: string) => Promise<readonly ModelCapability[] | undefined>;
  /** Fabrique des runtimes (tests). Défaut : `createAgentRuntime` d'agent-core. */
  createRuntime?: typeof createAgentRuntime;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Modèle qui lit les images d'une conversation (D4 de #13) : le modèle vision
 * des Réglages s'il est défini ; sinon le modèle de la conversation s'il a la
 * capacité `vision` ou si ses capacités sont inconnues ; sinon aucun (les outils
 * de documents expliquent alors comment en obtenir un).
 */
export function visionModelFor(options: {
  visionModel: string | undefined;
  model: string;
  capabilities: readonly ModelCapability[] | undefined;
}): string | undefined {
  if (options.visionModel) return options.visionModel;
  if (options.capabilities === undefined || options.capabilities.includes('vision')) {
    return options.model;
  }
  return undefined;
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

/** Héberge les runtimes (un par modèle) et crée les sessions agent. */
export class AgentRuntimeHost implements AgentSessionFactory {
  readonly #o: AgentRuntimeHostOptions;
  readonly #webTools: AnyToolDefinition[];
  /** Runtimes par modèle, du moins au plus récemment utilisé (ordre d'insertion). */
  readonly #runtimes = new Map<string, Promise<AgentRuntime>>();
  #generation = 0;
  #skills: readonly SkillInfo[] = [];

  constructor(options: AgentRuntimeHostOptions) {
    this.#o = options;
    this.#webTools = createWebTools(searchProviders(options.settings, options.secret));
  }

  generation(): number {
    return this.#generation;
  }

  /** Les Réglages LLM ou le token ont changé : le prochain tour utilisera de nouveaux runtimes. */
  invalidate(): void {
    this.#runtimes.clear();
    this.#generation += 1;
  }

  /** Le serveur est revenu : relit la fenêtre de contexte de chaque runtime qui l'avait devinée. */
  async refreshIfFallback(): Promise<void> {
    await Promise.all(
      [...this.#runtimes.values()].map(async (pending) => {
        try {
          const runtime = await pending;
          if (runtime.contextWindowSource === 'fallback') await runtime.refreshContextWindow();
        } catch {
          // Runtime invalide : l'erreur ressortira au prochain tour.
        }
      }),
    );
  }

  /**
   * Prépare un tour : dossier (et dossiers rattachés d'un projet) montés dans la
   * VM, réseau de la session, skills relus. `sandbox: false` (run planifié sans
   * commandes) ne touche pas à la VM.
   */
  async beforeTurn(
    sessionId: string,
    workspace: string,
    options: { sandbox?: boolean; folders?: readonly SandboxFolderMount[] } = {},
  ): Promise<void> {
    const [, skills] = await Promise.all([
      options.sandbox === false
        ? Promise.resolve(undefined)
        : this.#o.sandbox.prepareForTurn(sessionId, workspace, options.folders ?? []),
      loadSkills(this.#o.settings().skillsDir, {
        onWarning: (w) => this.#o.log?.('skill ignoré', { dir: w.dir, message: w.message }),
      }),
    ]);
    this.#skills = skills;
  }

  async createSession(options: NewAgentSession): Promise<AgentSessionLike> {
    const runtime = await this.#runtimeFor(options.model);
    return runtime.createSession({
      sessionId: options.sessionId,
      workspace: options.workspace,
      requestPermission: options.requestPermission,
      history: options.history,
      ...(options.lastInputTokens !== undefined
        ? { lastInputTokens: options.lastInputTokens }
        : {}),
      // Consignes du mode autonome (ADR-002 D3), propres à cette session.
      ...(options.instructions !== undefined ? { extraInstructions: options.instructions } : {}),
      // Run sans « commandes » : aucune VM, même si celle du runtime est prête.
      ...(options.sandbox === false ? { sandbox: false as const } : {}),
      // Projet (ADR-003) : contexte relu à chaque tour et outils propres à la session.
      ...(options.project ? { project: options.project } : {}),
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    });
  }

  /** Runtime du modèle : réutilisé (et marqué récent), sinon créé en évinçant le plus ancien. */
  #runtimeFor(model: string): Promise<AgentRuntime> {
    // « atelier » et « atelier:latest » partagent un runtime ; le nom reçu part tel quel au serveur.
    const key = modelKey(model);
    const cached = this.#runtimes.get(key);
    if (cached) {
      this.#runtimes.delete(key);
      this.#runtimes.set(key, cached);
      return cached;
    }
    const created = this.#create(model);
    // Un échec (URL invalide) n'est pas mis en cache : réessayé au tour suivant.
    created.catch(() => {
      if (this.#runtimes.get(key) === created) this.#runtimes.delete(key);
    });
    this.#runtimes.set(key, created);
    // Un runtime évincé reste utilisable par les sessions qui le tiennent déjà.
    for (const oldest of this.#runtimes.keys()) {
      if (this.#runtimes.size <= MAX_RUNTIMES) break;
      this.#runtimes.delete(oldest);
    }
    return created;
  }

  async #create(model: string): Promise<AgentRuntime> {
    const { baseUrl, thinking, numCtx, visionModel } = this.#o.settings().llm;
    if (baseUrl === '') {
      throw new AtelierError('llm/unreachable', 'Aucun serveur configuré.', {
        details: { kind: 'server_not_configured' },
      });
    }
    const token = this.#o.secret('llm_token');
    const { mcp, sandbox } = this.#o;
    // Vision (D4) : sans modèle capable de lire les images, les outils de
    // documents l'expliquent à l'utilisateur au lieu d'appeler le serveur.
    const visionTarget = visionModelFor({
      visionModel,
      model,
      capabilities: visionModel
        ? undefined
        : await this.#o.capabilities?.(model).catch(() => undefined),
    });
    // Thinking coupé pour la vision.
    const vision = visionTarget
      ? createVisionAnalyzer({
          model: createLlmModels({
            baseUrl,
            model: visionTarget,
            thinking: false,
            ...(token ? { token } : {}),
          }).fastModel,
        })
      : undefined;
    // Budget de sortie de read_file : relu à chaque appel, il suit la fenêtre de
    // contexte résolue par le runtime (après sa création, et à chaque refresh).
    let runtime: AgentRuntime | undefined;
    const created = (this.#o.createRuntime ?? createAgentRuntime)({
      llm: {
        baseUrl,
        model,
        thinking,
        ...(token ? { token } : {}),
        ...(numCtx !== undefined ? { numCtx } : {}),
      },
      tools: [
        ...createDocumentTools({
          ...(vision ? { vision } : {}),
          maxOutputTokens: () =>
            outputTokensForContext(runtime?.contextWindow ?? FALLBACK_CONTEXT_WINDOW),
          // SKILL.md lisible en lecture seule hors du dossier de travail (#60).
          readRoots: () => skillReadRoots(this.#skills),
        }),
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
    return created.then((value) => (runtime = value));
  }
}
