/**
 * Boucle agentique : un tour = `streamText` multi-étapes (jusqu'à 50) dont le
 * `fullStream` est traduit en {@link AgentEvent} typés.
 */
import {
  APICallError,
  InvalidResponseDataError,
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
  type TodoItem,
  type TokenUsage,
  type ToolRegistry,
  type WebSearchResult,
} from '@atelier/shared';
import { toLlmError } from '../llm/errors.js';
import { buildSystemPrompt, type PromptProject } from '../prompt/system-prompt.js';
import type { PermissionDescriber } from '../tools/permission.js';
import { isToolOutput, toAiSdkTools, type ToolRuntime } from '../tools/registry.js';
import { withRetryListener, type RetryInfo } from '../llm/retry-fetch.js';
import { ToolOutputBudget } from './budget.js';
import {
  APP_MESSAGE_PREFIX,
  COMPACTION_TARGET_SHARE,
  injectedMessage,
  compactMessages,
  estimateMessagesTokens,
  shouldCompact,
} from './compaction.js';
import { hasReasoning, stripReasoning } from './history.js';
import { sourceText, unverifiedAmounts, verificationPrompt } from './numbers.js';
import { createToolCallRepair } from './repair.js';
import { skillAutoloadMessages } from './skill-autoload.js';
import { TurnUsageMeter } from './usage.js';

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
  /**
   * Projet de la conversation (ADR-003), relu au début de chaque tour :
   * dossiers rattachés (outils fichiers), consignes, mémoire et artefacts (prompt).
   * Une erreur de lecture est journalisée et le tour continue sans projet.
   */
  project?: () => PromptProject | undefined | Promise<PromptProject | undefined>;
  /** Libellés des demandes de permission. */
  describePermission?: PermissionDescriber;
  /** URL du serveur (messages d'erreur). */
  serverUrl?: string;
  /** Messages récents conservés lors d'une compaction (défaut 6). */
  keepRecentOnCompaction?: number;
  /** Horloge injectable (tests). */
  now?: () => Date;
  /** Horloge monotone en ms pour mesurer la génération (défaut `performance.now`, tests). */
  clock?: () => number;
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
  /** Consommation (dernière étape en entrée, total en sortie, cumuls, débit, relances). */
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
  /** Dernier projet lu avec succès : repli si une lecture échoue (dossiers rattachés gardés). */
  #lastProject: PromptProject | undefined;

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

  /** Skills disponibles pour ce tour (getter relu). */
  currentSkills(): readonly SkillInfo[] {
    const skills = this.#options.skills;
    return (typeof skills === 'function' ? skills() : skills) ?? [];
  }

  /**
   * Projet du tour (getter relu). Si la lecture échoue, le dernier projet lu
   * avec succès sert encore : sans lui, `write_file("Compta/x")` se résoudrait
   * dans le dossier principal et y créerait un dossier `Compta/` qui masquerait
   * ensuite le dossier rattaché. `undefined` sans projet ou sans lecture réussie.
   */
  async currentProject(): Promise<PromptProject | undefined> {
    const { project } = this.#options;
    if (!project) return undefined;
    try {
      const read = await project();
      this.#lastProject = read;
      return read;
    } catch (error) {
      this.#options.log?.('project:unavailable', {
        message: error instanceof Error ? error.message : String(error),
        fallback: this.#lastProject !== undefined,
      });
      return this.#lastProject;
    }
  }

  /** Prompt système effectif (`project` : celui du tour, voir {@link currentProject}). */
  systemPrompt(
    sandbox: Sandbox | undefined = this.currentSandbox(),
    project?: PromptProject,
  ): string {
    const o = this.#options;
    if (o.instructions !== undefined) return o.instructions;
    const skills = this.currentSkills();
    const extra =
      typeof o.extraInstructions === 'function' ? o.extraInstructions() : o.extraInstructions;
    return buildSystemPrompt({
      workspace: o.workspace,
      now: o.now?.() ?? new Date(),
      toolNames: o.registry.list().map((t) => t.name),
      sandboxAvailable: sandbox !== undefined,
      ...(skills.length > 0 ? { skills } : {}),
      ...(extra !== undefined && extra !== '' ? { extra } : {}),
      ...(project ? { project } : {}),
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

    // Projet relu à chaque tour : un dossier ajouté sert dès ce tour (ADR-003 D1).
    const project = await this.currentProject();
    // Skill chargé d'office si la demande contient l'un de ses déclencheurs (critère 2).
    const skillMessages = await skillAutoloadMessages(turn.input, this.currentSkills(), {
      onLoad: (info) => o.log?.('skill-autoload', info),
      onError: (info) => o.log?.('skill-autoload:error', info),
    });
    let base: ModelMessage[] = [
      ...stripReasoning(turn.history),
      { role: 'user', content: turn.input },
      ...skillMessages,
    ];
    let responseOffset = 0;
    const meter = new TurnUsageMeter(o.contextWindow, o.clock ?? (() => performance.now()));
    const sources = new Map<string, WebSearchResult>();

    const usage = (): TokenUsage => meter.snapshot();
    // Usage cumulé après chaque étape : jauge de contexte en temps réel (ticket #10).
    const emitUsage = (): void => {
      turn.emit({ type: 'usage', usage: usage(), sessionId: turn.sessionId, turnId: turn.turnId });
    };
    /**
     * `requestTokens` : taille (réelle ou estimée) de la requête qui a déclenché
     * la compaction. L'écart avec l'estimation de l'historique est le surcoût fixe
     * (prompt système, schémas d'outils), retranché de la cible.
     */
    const compact = async (
      messages: ModelMessage[],
      requestTokens: number,
    ): Promise<ModelMessage[] | null> => {
      const overhead = Math.max(0, requestTokens - estimateMessagesTokens(messages));
      const result = await compactMessages({
        model: o.fastModel ?? o.model,
        messages,
        keepRecent: o.keepRecentOnCompaction ?? 6,
        abortSignal: signal,
        maxTranscriptChars: Math.floor(o.contextWindow * 1.5),
        // Réduit d'abord les anciens résultats d'outils, puis résume les tours précédents.
        targetTokens: Math.max(0, Math.floor(o.contextWindow * COMPACTION_TARGET_SHARE) - overhead),
      });
      const touched = result.replaced + result.pruned;
      if (touched === 0) return null;
      o.log?.('compaction', { replaced: result.replaced, pruned: result.pruned });
      emit({ type: 'compaction', replacedMessages: touched });
      return result.messages;
    };

    // Les nouvelles tentatives réseau de ce tour deviennent des events `llm_retry`.
    const onRetry = (info: RetryInfo): void => {
      emit({ type: 'llm_retry', ...info });
    };
    return withRetryListener(onRetry, async (): Promise<TurnResult> => {
      try {
        // Compaction préalable, sur la base de la consommation du tour précédent.
        if (
          turn.lastInputTokens !== undefined &&
          shouldCompact(turn.lastInputTokens, o.contextWindow)
        ) {
          base = (await compact(base, turn.lastInputTokens)) ?? base;
        }

        const sandbox = this.currentSandbox();
        // Sorties d'outils bornées par étape selon la fenêtre (num_ctx = plafond, pas garantie).
        const budget = new ToolOutputBudget(o.contextWindow);
        const runtime: ToolRuntime = {
          sessionId: turn.sessionId,
          workspace: o.workspace,
          ...(project && project.folders.length > 0 ? { folders: project.folders } : {}),
          abortSignal: signal,
          requestPermission: this.#permissionRelay(emit),
          emitDisplay: (toolCallId, display) => {
            emit({ type: 'tool_display', toolCallId, display });
          },
          ...(sandbox ? { sandbox } : {}),
          ...(o.describePermission ? { describePermission: o.describePermission } : {}),
          limitOutput: (toolName, output) => {
            const fitted = budget.fit(toolName, output.content);
            if (!fitted.truncated) return output;
            o.log?.('tool-output:truncated', { toolName, stepLimit: budget.stepLimit });
            return { ...output, content: fitted.content };
          },
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

        const maxSteps = o.maxSteps ?? MAX_STEPS;
        let todos: readonly TodoItem[] | undefined; // liste mise à jour pendant ce tour
        let continuations = 0;
        const cutRetries = new Map<StreamCutReason, number>();
        let usedTools = false;
        let verified = false;
        // Relances d'un tour qui cale (pas vide #73, annonce sans action #79) : budget commun.
        let stallRetries = 0;
        let emptyFinal = false;
        let lastText = '';
        let finishReason: string | undefined;
        let streamError: unknown;
        let aborted = false;
        let messages: ModelMessage[] = base;
        for (;;) {
          const result = streamText({
            model: o.model,
            instructions: this.systemPrompt(sandbox, project),
            messages: base,
            tools,
            ...(lazy ? { activeTools: activeTools() } : {}),
            stopWhen: stepCountIs(Math.max(1, maxSteps - meter.steps)),
            abortSignal: signal,
            // Les nouvelles tentatives réseau sont gérées par le fetch du provider.
            maxRetries: 0,
            // Erreurs du flux : traitées plus bas (event `error`) ; sans ce rappel,
            // l'AI SDK les écrit aussi sur la console.
            onError: ({ error }) => {
              o.log?.('stream-error', streamErrorLog(error));
            },
            // Une seule permission à la fois dans l'UI : exécution séquentielle.
            toolCallConcurrency: 1,
            repairToolCall: createToolCallRepair((info) => {
              o.log?.('repair', info);
            }),
            prepareStep: async ({ messages, steps: done, responseMessages }) => {
              let next = messages;
              let changed = false;
              const last = done.at(-1);
              // Taille estimée de la prochaine requête : entrée et sortie de l'étape
              // précédente, plus les résultats d'outils qu'elle a ajoutés.
              let estimate =
                last?.usage.inputTokens !== undefined
                  ? last.usage.inputTokens + (last.usage.outputTokens ?? 0) + budget.usedThisStep
                  : undefined;
              if (estimate !== undefined && shouldCompact(estimate, o.contextWindow)) {
                const compacted = await compact(next, estimate);
                if (compacted) {
                  next = compacted;
                  changed = true;
                  estimate = undefined;
                }
              }
              budget.startStep(estimate);
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

          finishReason = undefined;
          lastText = '';
          // `stream` est le nom v7 de `fullStream` (déprécié).
          for await (const part of result.stream) {
            switch (part.type) {
              case 'start-step':
                lastText = '';
                meter.startStep();
                break;
              case 'text-delta':
                meter.chunk();
                if (part.text !== '') emit({ type: 'text_delta', delta: part.text });
                lastText += part.text;
                break;
              case 'reasoning-delta':
                meter.chunk();
                if (part.text !== '') emit({ type: 'reasoning_delta', delta: part.text });
                break;
              case 'tool-input-start':
              case 'tool-input-delta':
                meter.chunk();
                break;
              case 'tool-call':
                meter.chunk();
                usedTools = true;
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
                    todos = output.display.todos;
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
                meter.finishStep(part.usage);
                emitUsage();
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

          const responseMessages = await Promise.resolve(result.responseMessages).catch(
            () => [] as ModelMessage[],
          );
          messages = stripReasoning([...base, ...responseMessages.slice(responseOffset)]);

          if (aborted || signal.aborted) break;
          if (streamError !== undefined) {
            // Flux coupé sans fin (Ollama, jeton réservé <tool_call> recopié) : une
            // relance qui demande de reprendre en écrivant la balise autrement.
            const cut = streamCutReason(streamError);
            const attempt = cut === undefined ? 0 : (cutRetries.get(cut) ?? 0) + 1;
            if (cut === undefined || attempt > MAX_STREAM_CUT_RETRIES) break;
            cutRetries.set(cut, attempt);
            meter.relaunch(cut);
            o.log?.('stream-cut:retry', { reason: cut, attempt, partialChars: lastText.length });
            if (lastText.trim() !== '') emit({ type: 'text_delta', delta: '\n\n' });
            const partial: ModelMessage[] =
              lastText.trim() !== '' && !endsWithText(messages, lastText)
                ? [{ role: 'assistant', content: [{ type: 'text', text: lastText }] }]
                : [];
            base = [...messages, ...partial, injectedMessage(cut, streamCutPrompt(cut))];
            responseOffset = 0;
            streamError = undefined;
            continue;
          }
          if (finishReason !== 'stop' || meter.steps >= maxSteps) break;
          // Le modèle a rendu la main (« stop ») en laissant des tâches ouvertes : on le
          // relance, au plus MAX_CONTINUATIONS fois, sauf s'il pose une question.
          const open = openTodos(todos);
          if (
            open.some((t) => t.status === 'pending') &&
            continuations < MAX_CONTINUATIONS &&
            !lastText.trim().endsWith('?')
          ) {
            continuations += 1;
            meter.relaunch('continuation');
            o.log?.('continuation', { attempt: continuations, open: open.length });
            base = [...messages, injectedMessage('continuation', continuationPrompt(open))];
            responseOffset = 0;
            continue;
          }
          // Dernier pas vide (#73) : ni texte ni appel d'outil, alors que le tour a
          // utilisé des outils. Une relance, puis une erreur claire.
          if (usedTools && lastText.trim() === '') {
            if (stallRetries < MAX_EMPTY_FINAL_RETRIES) {
              stallRetries += 1;
              meter.relaunch('empty_final');
              o.log?.('empty-final', { attempt: stallRetries });
              base = [
                ...withoutEmptyAssistant(messages),
                injectedMessage('empty_final', emptyFinalPrompt()),
              ];
              responseOffset = 0;
              continue;
            }
            o.log?.('empty-final', { attempt: stallRetries + 1, gaveUp: true });
            emptyFinal = true;
            break;
          }
          // Annonce sans action (#79) : « Commençons par… ensuite je vais… », sans appel
          // d'outil. Même budget que le pas vide ; au second échec, le texte reste.
          if (usedTools && stallRetries < MAX_EMPTY_FINAL_RETRIES && announcesAction(lastText)) {
            stallRetries += 1;
            meter.relaunch('announce_only');
            o.log?.('announce-only', { attempt: stallRetries, tail: lastText.trim().slice(-120) });
            emit({ type: 'text_delta', delta: '\n\n' });
            base = [...messages, injectedMessage('announce_only', announceOnlyPrompt())];
            responseOffset = 0;
            continue;
          }
          // Réponse finale d'un tour qui a utilisé des outils : un montant cité doit
          // figurer dans les données du tour (#61). Une seule vérification par tour.
          if (usedTools && !verified) {
            const missing = unverifiedAmounts(lastText, sourceText(messages));
            if (missing.length > 0) {
              verified = true;
              meter.relaunch('verification');
              o.log?.('verification', { amounts: missing });
              emit({ type: 'text_delta', delta: '\n\n' });
              base = [...messages, injectedMessage('verification', verificationPrompt(missing))];
              responseOffset = 0;
              continue;
            }
          }
          break;
        }

        if (sources.size > 0) emit({ type: 'sources', sources: [...sources.values()] });

        if (aborted || signal.aborted) {
          emit({ type: 'done', reason: 'aborted', usage: usage() });
          return { messages, usage: usage(), reason: 'aborted' };
        }
        if (streamError !== undefined) {
          const cut = streamCutReason(streamError);
          const error = (
            cut !== undefined
              ? streamCutError(streamError, cut)
              : toLlmError(streamError, o.serverUrl)
          ).toJSON();
          emit({ type: 'error', error });
          return { messages, usage: usage(), reason: 'error', error };
        }
        if (emptyFinal) {
          const error = emptyFinalError().toJSON();
          emit({ type: 'error', error });
          return { messages, usage: usage(), reason: 'error', error };
        }
        const reason: DoneReason =
          finishReason === 'length'
            ? 'length'
            : finishReason === 'tool-calls' && meter.steps >= maxSteps
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

/** Relances max., par nature de coupure, dans un même tour (#42, #69). */
export const MAX_STREAM_CUT_RETRIES = 1;

/**
 * Coupures du serveur qui justifient une relance (`details.reason` de l'erreur finale) :
 * - `stream_cut` : flux terminé sans `finish_reason` ni `[DONE]` ; Ollama (parseur
 *   Qwen) le fait quand le modèle écrit le jeton réservé `<tool_call>` dans du texte (#42) ;
 * - `tool_call_parse` : HTTP 500 d'Ollama dont le journal dit `tool call parsing
 *   failed error=EOF` ; le parseur n'a pas pu décoder l'appel d'outil que le modèle
 *   venait d'ouvrir (#69). Le client ne reçoit qu'un corps « EOF ».
 */
export type StreamCutReason = 'stream_cut' | 'tool_call_parse';

const TOOL_CALL_PARSE = /tool call parsing failed|\bEOF\b/i;

/** Nature de la coupure, ou `undefined` si l'erreur n'en est pas une. */
export function streamCutReason(error: unknown): StreamCutReason | undefined {
  if (
    InvalidResponseDataError.isInstance(error) &&
    /without a finish reason/i.test(error.message)
  ) {
    return 'stream_cut';
  }
  if (
    APICallError.isInstance(error) &&
    error.statusCode === 500 &&
    (TOOL_CALL_PARSE.test(error.message) || TOOL_CALL_PARSE.test(error.responseBody ?? ''))
  ) {
    return 'tool_call_parse';
  }
  return undefined;
}

/** Vrai si l'erreur est une coupure du serveur qui justifie une relance. */
export function isStreamCut(error: unknown): boolean {
  return streamCutReason(error) !== undefined;
}

/** Message de relance après une coupure (invisible dans l'UI). */
export function streamCutPrompt(reason: StreamCutReason = 'stream_cut'): string {
  if (reason === 'tool_call_parse') {
    return `${APP_MESSAGE_PREFIX} Le serveur n'a pas pu lire ton dernier appel d'outil : il était incomplet ou mal formé. Refais un seul appel d'outil, complet, avec des arguments JSON valides. Si tu écrivais un long fichier, découpe-le : crée-le avec write_file et une première partie courte, puis complète-le par des appels plus courts (edit_file, ou un script dans la machine isolée).`;
  }
  return `${APP_MESSAGE_PREFIX} Ta réponse a été coupée par le serveur : <tool_call> est une balise réservée du modèle, qui ne peut pas être écrite telle quelle. Continue ta réponse exactement là où elle s'est arrêtée, sans répéter ce qui précède, en écrivant chaque balise réservée (<tool_call>, </tool_call>, <tool_response>) avec une espace après le chevron : < tool_call>, < /tool_call>. Si un fichier doit contenir ces balises, écris-le avec un script qui assemble la balise (par exemple '<' + 'tool_call>').`;
}

/** Erreur finale si la relance échoue à son tour : pas de « Réessayer » en boucle. */
export function streamCutError(
  cause: unknown,
  reason: StreamCutReason = 'stream_cut',
): AtelierError {
  const message =
    reason === 'tool_call_parse'
      ? "Le serveur n'a pas pu lire un appel d'outil du modèle, même après une nouvelle tentative. Cela arrive surtout quand le modèle écrit un très long fichier d'un seul bloc : demandez-lui de le produire en plusieurs parties, ou découpez la demande."
      : "Le serveur a interrompu la réponse du modèle avant la fin. Cela arrive quand le texte contient une balise réservée du modèle (<tool_call>) : reformulez la demande sans cette balise, ou demandez au modèle de l'écrire « < tool_call> ».";
  return new AtelierError('llm/bad_response', message, {
    retryable: false,
    cause,
    details: { reason },
  });
}

/** Taille max. du corps de réponse HTTP recopié dans le journal `stream-error`. */
export const LOGGED_RESPONSE_BODY_CHARS = 500;

/**
 * Données du journal `stream-error` : le message, et pour une erreur HTTP du
 * serveur son statut et le début du corps (diagnostic d'un 500 d'Ollama, #69).
 */
export function streamErrorLog(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (!APICallError.isInstance(error)) return { message };
  const body = error.responseBody;
  return {
    message,
    ...(error.statusCode !== undefined ? { status: error.statusCode } : {}),
    ...(body !== undefined && body !== ''
      ? {
          responseBody:
            body.length > LOGGED_RESPONSE_BODY_CHARS
              ? `${body.slice(0, LOGGED_RESPONSE_BODY_CHARS)}…`
              : body,
        }
      : {}),
  };
}

/** Relances max. d'un dernier pas vide dans un même tour (#73). */
export const MAX_EMPTY_FINAL_RETRIES = 1;

/** Message de relance après un dernier pas vide (invisible dans l'UI). */
export function emptyFinalPrompt(): string {
  return `${APP_MESSAGE_PREFIX} Ta dernière réponse est vide : ni texte ni appel d'outil. Continue la tâche avec les appels d'outils nécessaires ; si elle est terminée, donne ta réponse finale à l'utilisateur ; si quelque chose te bloque, explique-le.`;
}

// Annonce d'une action à venir, en fin de réponse (français et anglais).
// Bornes Unicode : `\b` ne reconnaît pas les lettres accentuées (« passons à »).
const ANNOUNCE =
  /(?<!\p{L})(?:je vais|j['’]?vais|commençons|commencons|je commence|laisse[- ]moi|laissez[- ]moi|maintenant,? je|ensuite,? (?:je|j['’]|nous)|passons (?:à|au|aux)|je m['’]apprête|voyons|i['’]ll|i will|i am going to|i['’]m going to|let me|let['’]s|now,? i|next,? i)(?!\p{L})/iu;

/** Dernière phrase non vide d'un texte (ce qui reste « en suspens » à la fin). */
function lastSentence(text: string): string {
  const lines = text
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '');
  const line = lines.at(-1)?.trim() ?? '';
  const sentences = line.split(/(?<=[.!])\s+/);
  return sentences.at(-1) ?? line;
}

/**
 * Vrai si la réponse s'arrête sur l'annonce d'une action non faite (#79) :
 * « Commençons par examiner les autres fichiers et ensuite je vais… », ou une
 * phrase qui finit par « : ». Une question finale n'en est pas une.
 */
export function announcesAction(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.endsWith('?')) return false;
  if (trimmed.endsWith(':')) return true;
  return ANNOUNCE.test(lastSentence(trimmed));
}

/** Message de relance après une annonce sans action (invisible dans l'UI). */
export function announceOnlyPrompt(): string {
  return `${APP_MESSAGE_PREFIX} Tu as annoncé une action sans la faire : ta réponse ne contient aucun appel d'outil. Fais-la maintenant avec les appels d'outils nécessaires, sans la réannoncer ; si la tâche est en fait terminée, donne directement ta réponse finale à l'utilisateur.`;
}

/** Erreur finale si le modèle rend encore une réponse vide après la relance. */
export function emptyFinalError(): AtelierError {
  return new AtelierError(
    'llm/bad_response',
    "Le modèle s'est arrêté sans répondre, même après une relance. Les fichiers déjà produits sont conservés : relancez la demande ou précisez l'étape qui reste à faire.",
    { retryable: false, details: { reason: 'empty_final' } },
  );
}

/** Retire un dernier message assistant sans contenu (pas vide), inutile à renvoyer. */
function withoutEmptyAssistant(messages: readonly ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  const empty =
    last?.role === 'assistant' &&
    (typeof last.content === 'string'
      ? last.content.trim() === ''
      : last.content.every((p) => p.type === 'text' && p.text.trim() === ''));
  return empty ? messages.slice(0, -1) : [...messages];
}

function endsWithText(messages: readonly ModelMessage[], text: string): boolean {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return false;
  const content =
    typeof last.content === 'string'
      ? last.content
      : last.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return content.trimEnd().endsWith(text.trim());
}

/** Relances max. d'un tour qui s'arrête avec des tâches encore ouvertes. */
export const MAX_CONTINUATIONS = 2;

function openTodos(todos: readonly TodoItem[] | undefined): TodoItem[] {
  return (todos ?? []).filter((t) => t.status !== 'completed');
}

/** Message de relance (invisible dans l'UI, conservé dans l'historique modèle). */
export function continuationPrompt(open: readonly TodoItem[]): string {
  const list = open.map((t) => `- ${t.title} (${t.status})`).join('\n');
  return `${APP_MESSAGE_PREFIX} Ta réponse s'est arrêtée alors que des tâches de ta liste ne sont pas terminées :\n${list}\nContinue maintenant avec les appels d'outils nécessaires, sans attendre de réponse. Si une tâche n'est plus utile, mets la liste à jour avec todo_write ; si tu as besoin de l'utilisateur, pose-lui ta question.`;
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
