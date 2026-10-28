/**
 * Boucle agentique : un tour = `streamText` multi-étapes (jusqu'à 50) dont le
 * `fullStream` est traduit en {@link AgentEvent} typés.
 */
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UserContent,
} from 'ai';
import {
  AtelierError,
  InMemoryToolRegistry,
  serializeError,
  type AgentEvent,
  type AnyToolDefinition,
  type AgentEventSink,
  type DoneReason,
  type PermissionHandler,
  type PermissionRequest,
  type Sandbox,
  type SerializedAtelierError,
  type SkillInfo,
  type TokenUsage,
  type ToolRegistry,
  type WebSearchResult,
} from '@atelier/shared';
import { toLlmError } from '../llm/errors.js';
import { buildSystemPrompt } from '../prompt/system-prompt.js';
import type { PermissionDescriber } from '../tools/permission.js';
import { isToolOutput, toAiSdkTools, type ToolRuntime } from '../tools/registry.js';
import { withRetryListener, type RetryInfo } from '../llm/retry-fetch.js';
import { compactMessages, shouldCompact } from './compaction.js';
import { hasReasoning, stripReasoning } from './history.js';
import { createToolCallRepair } from './repair.js';

/** Nombre maximal d'étapes par tour (brief §1). */
export const MAX_STEPS = 50;

/** Configuration d'un agent (stable pour une session). */
export interface AgentOptions {
  /** Modèle principal. */
  model: LanguageModel;
  /** Modèle rapide (thinking coupé) pour les résumés ; défaut : `model`. */
  fastModel?: LanguageModel;
  /** Registre d'outils (natifs, documents, web, MCP). */
  registry: ToolRegistry;
  /**
   * Outils activables en cours de tour (chargement paresseux, ex. outils MCP via
   * `tool_search`). Ils sont déclarés à l'AI SDK en début de tour mais restent
   * inactifs (`activeTools`) tant qu'ils ne sont pas dans le registre ; un outil
   * enregistré pendant le tour devient appelable dès l'étape suivante.
   * L'application passe en pratique `() => mcp.definitions()`.
   */
  lazyTools?: () => readonly AnyToolDefinition[];
  /** Dossier de travail autorisé (absolu). */
  workspace: string;
  /** Gestionnaire de permissions (modale côté app). */
  requestPermission: PermissionHandler;
  /**
   * VM d'exécution, si prête. Un getter est relu au début de chaque tour (la VM
   * peut devenir prête après la création de la session) : `undefined` = pas de VM.
   */
  sandbox?: Sandbox | (() => Sandbox | undefined);
  /** Fenêtre de contexte réelle (lue via `/api/show`). */
  contextWindow: number;
  /** Étapes max par tour (défaut {@link MAX_STEPS}). */
  maxSteps?: number;
  /** Skills listés dans le prompt système (getter relu à chaque tour). */
  skills?: readonly SkillInfo[] | (() => readonly SkillInfo[]);
  /** Prompt système complet (remplace celui construit par défaut). */
  instructions?: string;
  /** Consignes additionnelles ajoutées au prompt par défaut (getter relu à chaque tour). */
  extraInstructions?: string | (() => string | undefined);
  /** Libellés des demandes de permission. */
  describePermission?: PermissionDescriber;
  /** URL du serveur (messages d'erreur). */
  serverUrl?: string;
  /** Messages récents conservés lors d'une compaction (défaut 6). */
  keepRecentOnCompaction?: number;
  /** Horloge injectable (tests). */
  now?: () => Date;
  /** Journal de diagnostic (réparations, compaction…). */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Paramètres d'un tour. */
/** Options de {@link AgentSession.send}. */
export interface SendOptions {
  /** Identifiant du tour (défaut : `<sessionId>-<n>`). */
  turnId?: string;
}

export interface RunTurnOptions {
  sessionId: string;
  turnId: string;
  /** Historique modèle avant ce tour (sans raisonnement). */
  history: readonly ModelMessage[];
  /** Nouveau message de l'utilisateur. */
  input: UserContent;
  /** Récepteur des événements. */
  emit: AgentEventSink;
  /** Bouton stop. */
  abortSignal?: AbortSignal;
  /** `inputTokens` de la dernière étape du tour précédent (compaction préalable). */
  lastInputTokens?: number;
}

/** Bilan d'un tour. */
export interface TurnResult {
  /** Historique complet à conserver pour le tour suivant (raisonnement retiré). */
  messages: ModelMessage[];
  /** Consommation (dernière étape en entrée, total en sortie). */
  usage?: TokenUsage;
  /** Raison de fin, ou `error`. */
  reason: DoneReason | 'error';
  error?: SerializedAtelierError;
}

type EventPayload = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'sessionId' | 'turnId'>
    : never
  : never;

/** Agent Atelier : exécute des tours de conversation. */
export class Agent {
  readonly #options: AgentOptions;

  constructor(options: AgentOptions) {
    this.#options = options;
  }

  get options(): Readonly<AgentOptions> {
    return this.#options;
  }

  /** VM disponible maintenant (résout le getter éventuel). */
  currentSandbox(): Sandbox | undefined {
    const { sandbox } = this.#options;
    return typeof sandbox === 'function' ? sandbox() : sandbox;
  }

  /** Prompt système effectif. */
  systemPrompt(sandbox: Sandbox | undefined = this.currentSandbox()): string {
    const o = this.#options;
    if (o.instructions !== undefined) return o.instructions;
    const skills = typeof o.skills === 'function' ? o.skills() : o.skills;
    const extra =
      typeof o.extraInstructions === 'function' ? o.extraInstructions() : o.extraInstructions;
    return buildSystemPrompt({
      workspace: o.workspace,
      now: o.now?.() ?? new Date(),
      toolNames: o.registry.list().map((t) => t.name),
      sandboxAvailable: sandbox !== undefined,
      ...(skills ? { skills } : {}),
      ...(extra !== undefined && extra !== '' ? { extra } : {}),
    });
  }

  /** Exécute un tour complet ; ne lève jamais (les erreurs deviennent un event `error`). */
  async runTurn(turn: RunTurnOptions): Promise<TurnResult> {
    const o = this.#options;
    const emit = (payload: EventPayload): void => {
      turn.emit({ ...payload, sessionId: turn.sessionId, turnId: turn.turnId });
    };
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(turn.abortSignal?.reason);
    };
    if (turn.abortSignal?.aborted) controller.abort(turn.abortSignal.reason);
    turn.abortSignal?.addEventListener('abort', onAbort, { once: true });
    const signal = controller.signal;

    let base: ModelMessage[] = [
      ...stripReasoning(turn.history),
      { role: 'user', content: turn.input },
    ];
    let responseOffset = 0;
    let lastInputTokens: number | undefined;
    let outputTokens = 0;
    let steps = 0;
    const sources = new Map<string, WebSearchResult>();

    const usage = (): TokenUsage => ({
      inputTokens: lastInputTokens ?? 0,
      outputTokens,
      contextWindow: o.contextWindow,
    });
    const compact = async (messages: ModelMessage[]): Promise<ModelMessage[] | null> => {
      const result = await compactMessages({
        model: o.fastModel ?? o.model,
        messages,
        keepRecent: o.keepRecentOnCompaction ?? 6,
        abortSignal: signal,
        maxTranscriptChars: Math.floor(o.contextWindow * 1.5),
      });
      if (result.replaced === 0) return null;
      o.log?.('compaction', { replaced: result.replaced });
      emit({ type: 'compaction', replacedMessages: result.replaced });
      return result.messages;
    };

    // Les nouvelles tentatives réseau de ce tour deviennent des events `llm_retry`.
    const onRetry = (info: RetryInfo): void => {
      emit({ type: 'llm_retry', ...info });
    };
    return withRetryListener(onRetry, async (): Promise<TurnResult> => {
      try {
        // Compaction préalable, sur la base de la consommation du tour précédent.
        if (shouldCompact(turn.lastInputTokens, o.contextWindow)) {
          base = (await compact(base)) ?? base;
        }

        const sandbox = this.currentSandbox();
        const runtime: ToolRuntime = {
          sessionId: turn.sessionId,
          workspace: o.workspace,
          abortSignal: signal,
          requestPermission: this.#permissionRelay(emit),
          emitDisplay: (toolCallId, display) => {
            emit({ type: 'tool_display', toolCallId, display });
          },
          ...(sandbox ? { sandbox } : {}),
          ...(o.describePermission ? { describePermission: o.describePermission } : {}),
        };
        const tools: ToolSet = toAiSdkTools(o.registry, runtime);
        const lazy = o.lazyTools
          ? lazyToolSet(o.lazyTools(), o.registry, tools, runtime)
          : undefined;
        if (lazy) Object.assign(tools, lazy);
        // Outils déclarés à l'AI SDK et effectivement actifs : ceux du registre, recalculés
        // à chaque étape (le registre peut grandir pendant le tour via `tool_search`).
        const activeTools = (): string[] =>
          o.registry
            .list()
            .map((t) => t.name)
            .filter((name) => name in tools);

        const result = streamText({
          model: o.model,
          instructions: this.systemPrompt(sandbox),
          messages: base,
          tools,
          ...(lazy ? { activeTools: activeTools() } : {}),
          stopWhen: stepCountIs(o.maxSteps ?? MAX_STEPS),
          abortSignal: signal,
          // Les nouvelles tentatives réseau sont gérées par le fetch du provider.
          maxRetries: 0,
          // Une seule permission à la fois dans l'UI : exécution séquentielle.
          toolCallConcurrency: 1,
          repairToolCall: createToolCallRepair((info) => {
            o.log?.('repair', info);
          }),
          prepareStep: async ({ messages, steps: done, responseMessages }) => {
            let next = messages;
            let changed = false;
            const last = done.at(-1);
            if (last && shouldCompact(last.usage.inputTokens, o.contextWindow)) {
              const compacted = await compact(next);
              if (compacted) {
                next = compacted;
                changed = true;
              }
            }
            if (hasReasoning(next)) {
              next = stripReasoning(next);
              changed = true;
            }
            const active = lazy ? { activeTools: activeTools() } : {};
            if (!changed) return lazy ? active : undefined;
            // Les messages renvoyés remplacent l'historique pour les étapes suivantes.
            base = next;
            responseOffset = responseMessages.length;
            return { messages: next, ...active };
          },
        });

        let finishReason: string | undefined;
        let streamError: unknown;
        let aborted = false;
        // `stream` est le nom v7 de `fullStream` (déprécié).
        for await (const part of result.stream) {
          switch (part.type) {
            case 'text-delta':
              if (part.text !== '') emit({ type: 'text_delta', delta: part.text });
              break;
            case 'reasoning-delta':
              if (part.text !== '') emit({ type: 'reasoning_delta', delta: part.text });
              break;
            case 'tool-call':
              emit({
                type: 'tool_start',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              });
              break;
            case 'tool-result': {
              const output: unknown = part.output;
              if (isToolOutput(output)) {
                emit({
                  type: 'tool_result',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  ok: output.ok,
                  ...(output.denied ? { denied: true } : {}),
                  output: output.content,
                  ...(output.display ? { display: output.display } : {}),
                });
                if (output.display?.type === 'todos') {
                  emit({ type: 'todo_update', todos: output.display.todos });
                } else if (output.display?.type === 'web_results') {
                  for (const r of output.display.results) sources.set(r.url, r);
                } else if (output.display?.type === 'web_page') {
                  const { url, title } = output.display;
                  if (!sources.has(url))
                    sources.set(url, { url, title: title ?? url, snippet: '' });
                }
              } else {
                emit({
                  type: 'tool_result',
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  ok: true,
                  output: typeof output === 'string' ? output : JSON.stringify(output),
                });
              }
              break;
            }
            case 'tool-error':
              emit({
                type: 'tool_result',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                ok: false,
                output: describeToolError(part.error),
              });
              break;
            case 'finish-step':
              steps += 1;
              if (part.usage.inputTokens !== undefined) lastInputTokens = part.usage.inputTokens;
              outputTokens += part.usage.outputTokens ?? 0;
              break;
            case 'finish':
              finishReason = part.finishReason;
              break;
            case 'abort':
              aborted = true;
              break;
            case 'error':
              streamError = part.error;
              break;
            default:
              break;
          }
        }

        if (sources.size > 0) emit({ type: 'sources', sources: [...sources.values()] });

        const responseMessages = await Promise.resolve(result.responseMessages).catch(
          () => [] as ModelMessage[],
        );
        const messages = stripReasoning([...base, ...responseMessages.slice(responseOffset)]);

        if (aborted || signal.aborted) {
          emit({ type: 'done', reason: 'aborted', usage: usage() });
          return { messages, usage: usage(), reason: 'aborted' };
        }
        if (streamError !== undefined) {
          const error = toLlmError(streamError, o.serverUrl).toJSON();
          emit({ type: 'error', error });
          return { messages, usage: usage(), reason: 'error', error };
        }
        const reason: DoneReason =
          finishReason === 'length'
            ? 'length'
            : finishReason === 'tool-calls' && steps >= (o.maxSteps ?? MAX_STEPS)
              ? 'max_steps'
              : 'stop';
        emit({ type: 'done', reason, usage: usage() });
        return { messages, usage: usage(), reason };
      } catch (error) {
        if (signal.aborted) {
          emit({ type: 'done', reason: 'aborted', usage: usage() });
          return { messages: stripReasoning(base), usage: usage(), reason: 'aborted' };
        }
        const serialized =
          error instanceof AtelierError
            ? error.toJSON()
            : serializeError(toLlmError(error, o.serverUrl));
        emit({ type: 'error', error: serialized });
        return {
          messages: stripReasoning(base),
          usage: usage(),
          reason: 'error',
          error: serialized,
        };
      } finally {
        turn.abortSignal?.removeEventListener('abort', onAbort);
      }
    });
  }

  /** Relaie chaque demande de permission en event, puis attend la décision. */
  #permissionRelay(emit: (payload: EventPayload) => void): PermissionHandler {
    return (request: PermissionRequest, signal?: AbortSignal) => {
      emit({ type: 'permission_request', request });
      return this.#options.requestPermission(request, signal);
    };
  }
}

function describeToolError(error: unknown): string {
  if (error instanceof AtelierError) return error.message;
  if (error instanceof Error) return `Erreur de l'outil : ${error.message}`;
  return `Erreur de l'outil : ${String(error)}`;
}

/**
 * Session de conversation : conserve l'historique modèle et la consommation
 * entre les tours. Pratique pour la CLI et le process main.
 */
export class AgentSession {
  #history: ModelMessage[] = [];
  #lastInputTokens: number | undefined;
  #turn = 0;

  /**
   * @param lastInputTokens - `inputTokens` du dernier tour (session recréée,
   *   par ex. après un changement de réglages) : conserve le déclenchement de la
   *   compaction préalable au prochain tour.
   */
  constructor(
    readonly agent: Agent,
    readonly sessionId: string,
    history: readonly ModelMessage[] = [],
    lastInputTokens?: number,
  ) {
    this.#history = [...history];
    this.#lastInputTokens = lastInputTokens;
  }

  /** Historique modèle courant (raisonnement retiré), à persister ou à transmettre. */
  get history(): readonly ModelMessage[] {
    return this.#history;
  }

  /** `inputTokens` de la dernière étape du dernier tour, s'il est connu. */
  get lastInputTokens(): number | undefined {
    return this.#lastInputTokens;
  }

  /** Envoie un message utilisateur et exécute le tour. */
  async send(
    input: UserContent,
    emit: AgentEventSink,
    abortSignal?: AbortSignal,
    options: SendOptions = {},
  ): Promise<TurnResult> {
    this.#turn += 1;
    const result = await this.agent.runTurn({
      sessionId: this.sessionId,
      // Défaut : compteur local, qui repart à 1 si la session est recréée ; l'app
      // fournit un identifiant unique (renvoyé par `agent:send`).
      turnId: options.turnId ?? `${this.sessionId}-${this.#turn}`,
      history: this.#history,
      input,
      emit,
      ...(abortSignal ? { abortSignal } : {}),
      ...(this.#lastInputTokens !== undefined ? { lastInputTokens: this.#lastInputTokens } : {}),
    });
    this.#history = result.messages;
    if (result.usage) this.#lastInputTokens = result.usage.inputTokens;
    return result;
  }
}

/**
 * Outils paresseux absents du registre, convertis pour l'AI SDK. L'exécution
 * revérifie l'activation : un outil inactif appelé quand même (modèle qui devine
 * un nom) est refusé sans être exécuté.
 */
function lazyToolSet(
  definitions: readonly AnyToolDefinition[],
  registry: ToolRegistry,
  existing: ToolSet,
  runtime: ToolRuntime,
): ToolSet | undefined {
  const dormant = new InMemoryToolRegistry();
  for (const definition of definitions) {
    if (definition.name in existing || dormant.has(definition.name)) continue;
    dormant.register(definition);
  }
  if (dormant.list().length === 0) return undefined;
  const set = toAiSdkTools(dormant, runtime);
  for (const [name, aiTool] of Object.entries(set)) {
    const execute = aiTool.execute;
    if (!execute) continue;
    aiTool.execute = (input, options) => {
      if (!registry.has(name)) {
        return {
          ok: false,
          content: `L'outil ${name} n'est pas activé : appelle d'abord tool_search pour l'activer.`,
        };
      }
      // Garde placée avant l'adaptateur (et donc avant toute demande de permission).
      const result: unknown = execute(input, options);
      return result;
    };
  }
  return set;
}
