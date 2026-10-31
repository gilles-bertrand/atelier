/**
 * Fabrique d'assemblage pour le process main : connexion LLM + fenêtre de
 * contexte (une fois), puis une {@link AgentSession} par session de chat, avec
 * son propre registre d'outils (natifs + outils fournis + outils de session).
 *
 * agent-core ne dépend ni de `web`, ni de `mcp-bridge`, ni de `skills`, ni de
 * `sandbox` : l'app construit leurs instances et les passe ici.
 */
import type { ModelMessage } from 'ai';
import {
  MIN_CONTEXT_WINDOW,
  isAtelierError,
  type AnyToolDefinition,
  type PermissionHandler,
  type Sandbox,
  type SkillInfo,
  type ToolRegistry,
} from '@atelier/shared';
import { createDefaultRegistry } from './default-registry.js';
import { skillReadRoots } from './paths.js';
import { fetchContextWindow, type ContextWindowSource } from './llm/context-window.js';
import { createLlmModels, type LlmConnectionOptions, type LlmModels } from './llm/provider.js';
import { Agent, AgentSession, type AgentOptions } from './loop/agent.js';
import { withSessionMemory, type PermissionDescriber } from './tools/permission.js';

export interface AgentRuntimeLlmOptions extends LlmConnectionOptions {
  /** Fenêtre de contexte forcée (réglage `numCtx`). */
  numCtx?: number;
}

export interface AgentRuntimeOptions {
  /** Connexion au serveur LLM. */
  llm: AgentRuntimeLlmOptions;
  /**
   * Outils fournis par les autres packages (web, documents…), partagés par
   * toutes les sessions. Un outil fourni remplace l'outil natif de même nom :
   * réservé aux outils de l'app (ex. `read_file` de `packages/documents`) ; les
   * outils MCP, préfixés `mcp__`, ne peuvent pas masquer un natif.
   */
  tools?: readonly AnyToolDefinition[];
  /**
   * Outils qui ont besoin du registre de la session, créés pour chaque session
   * (ex. `(registry) => [toolSearchTool({ source: mcp, registry })]`).
   */
  sessionTools?: (registry: ToolRegistry) => readonly AnyToolDefinition[];
  /** Outils activables en cours de tour (ex. `() => mcp.definitions()`). */
  lazyTools?: AgentOptions['lazyTools'];
  /** VM d'exécution ou getter relu à chaque tour (`undefined` tant qu'elle n'est pas prête). */
  sandbox?: Sandbox | (() => Sandbox | undefined);
  /** Skills du prompt système (tableau ou getter relu à chaque tour). */
  skills?: readonly SkillInfo[] | (() => readonly SkillInfo[]);
  /** Consignes additionnelles (ex. `() => mcpPromptSection(mcp)`). */
  extraInstructions?: string | (() => string | undefined);
  describePermission?: PermissionDescriber;
  maxSteps?: number;
  keepRecentOnCompaction?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Tests : modèles déjà construits (court-circuite `createLlmModels`). */
  models?: Pick<LlmModels, 'model' | 'fastModel'>;
}

export interface CreateSessionOptions {
  sessionId: string;
  /** Dossier de travail absolu de la session. */
  workspace: string;
  /** Modale de permission ; les « autoriser pour la session » sont mémorisés ici. */
  requestPermission: PermissionHandler;
  /** Historique modèle persisté (`TurnResult.messages` des tours précédents). */
  history?: readonly ModelMessage[];
  /**
   * `inputTokens` du dernier tour (`session.lastInputTokens` de la session
   * remplacée) : garde la compaction préalable quand on recrée une session.
   */
  lastInputTokens?: number;
  /**
   * Consignes propres à cette session (ex. `UNATTENDED_INSTRUCTIONS` d'un run
   * planifié), ajoutées après les `extraInstructions` du runtime, partagé
   * entre les conversations du même modèle.
   */
  extraInstructions?: string;
  /**
   * `false` : session sans machine isolée, même si celle du runtime est prête
   * (`bash` répond « indisponible » sans rien exécuter). Ex. run planifié dont
   * la politique ne coche pas les commandes : sans bail sur la VM, celle-ci peut
   * être montée sur le dossier d'une autre conversation. Défaut : la VM du runtime.
   */
  sandbox?: false;
}

/** Provenance de la fenêtre de contexte ; `fallback` = serveur injoignable au démarrage. */
export type RuntimeContextSource = ContextWindowSource | 'fallback';

/** Assemblage prêt à créer des sessions. */
export interface AgentRuntime {
  readonly llm: Pick<LlmModels, 'model' | 'fastModel'> & { apiBaseUrl?: string };
  /** Fenêtre de contexte utilisée pour les nouvelles sessions. */
  readonly contextWindow: number;
  readonly contextWindowSource: RuntimeContextSource;
  /** Relit la fenêtre de contexte (ex. quand le serveur revient). Ne lève jamais. */
  refreshContextWindow(): Promise<number>;
  /** Crée une session de chat (registre propre, Agent lié au dossier de travail). */
  createSession(options: CreateSessionOptions): AgentSession;
}

/**
 * Construit le runtime. Ne lève que pour une configuration invalide (URL non
 * https, par exemple) ; un serveur injoignable donne `contextWindowSource:
 * 'fallback'` (l'erreur réelle remontera au premier tour, en event `error`).
 */
export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const { llm: llmOptions } = options;
  const llm = options.models ?? createLlmModels(llmOptions);
  let contextWindow = MIN_CONTEXT_WINDOW;
  let contextWindowSource: RuntimeContextSource = 'fallback';

  const refreshContextWindow = async (): Promise<number> => {
    try {
      const info = await fetchContextWindow({
        baseUrl: llmOptions.baseUrl,
        model: llmOptions.model,
        ...(llmOptions.token !== undefined ? { token: llmOptions.token } : {}),
        ...(llmOptions.numCtx !== undefined ? { override: llmOptions.numCtx } : {}),
        ...(llmOptions.fetch ? { fetch: llmOptions.fetch } : {}),
      });
      contextWindow = info.contextWindow;
      contextWindowSource = info.source;
    } catch (error) {
      options.log?.('context-window:fallback', {
        code: isAtelierError(error) ? error.code : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
      if (llmOptions.numCtx !== undefined && llmOptions.numCtx > 0) {
        contextWindow = llmOptions.numCtx;
        contextWindowSource = 'override';
      }
    }
    return contextWindow;
  };
  await refreshContextWindow();

  const currentSkills = (): readonly SkillInfo[] =>
    typeof options.skills === 'function' ? options.skills() : (options.skills ?? []);

  const createSession = (session: CreateSessionOptions): AgentSession => {
    // Racine des skills lisible en lecture seule par read_file / list_dir natifs (#60).
    const registry = createDefaultRegistry(options.tools ?? [], {
      readRoots: () => skillReadRoots(currentSkills()),
    });
    for (const tool of options.sessionTools?.(registry) ?? []) registry.register(tool);
    const agent = new Agent({
      model: llm.model,
      fastModel: llm.fastModel,
      registry,
      workspace: session.workspace,
      requestPermission: withSessionMemory(session.requestPermission),
      contextWindow,
      serverUrl: llmOptions.baseUrl,
      ...(options.lazyTools ? { lazyTools: options.lazyTools } : {}),
      ...(options.sandbox && session.sandbox !== false ? { sandbox: options.sandbox } : {}),
      ...(options.skills ? { skills: options.skills } : {}),
      ...sessionInstructions(options.extraInstructions, session.extraInstructions),
      ...(options.describePermission ? { describePermission: options.describePermission } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.keepRecentOnCompaction !== undefined
        ? { keepRecentOnCompaction: options.keepRecentOnCompaction }
        : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    return new AgentSession(
      agent,
      session.sessionId,
      session.history ?? [],
      session.lastInputTokens,
    );
  };

  return {
    llm,
    get contextWindow() {
      return contextWindow;
    },
    get contextWindowSource() {
      return contextWindowSource;
    },
    refreshContextWindow,
    createSession,
  };
}

/**
 * Consignes du runtime (relues à chaque tour) suivies de celles de la session.
 */
function sessionInstructions(
  runtime: AgentRuntimeOptions['extraInstructions'],
  session: string | undefined,
): { extraInstructions?: string | (() => string | undefined) } {
  if (session === undefined || session.trim() === '') {
    return runtime !== undefined ? { extraInstructions: runtime } : {};
  }
  return {
    extraInstructions: () => {
      const shared = typeof runtime === 'function' ? runtime() : runtime;
      return shared !== undefined && shared !== '' ? `${shared}\n\n${session}` : session;
    },
  };
}
