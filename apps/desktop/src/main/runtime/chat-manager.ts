/**
 * Sessions de chat côté main : un tour à la fois par session, relais des events
 * vers le renderer, persistance des messages affichés, stop et reprise.
 *
 * L'agent lui-même est fourni par `createRunner` à chaque tour (modèle, VM et
 * skills courants) ; le registre d'outils, lui, vit avec la session (les outils
 * activés par `tool_search` y restent enregistrés).
 */
import { randomUUID } from 'node:crypto';
import { chatMessagesToModelMessages } from '@atelier/agent-core';
import type { RunTurnOptions, TurnResult } from '@atelier/agent-core';
import {
  AtelierError,
  serializeError,
  type AgentEvent,
  type Attachment,
  type ChatMessage,
  type PermissionHandler,
  type SerializedAtelierError,
  type SessionSummary,
  type ToolRegistry,
} from '@atelier/shared';
import type { ModelMessage } from 'ai';
import {
  applyAgentEvent,
  createAssistantMessage,
  createUserMessage,
  deriveSessionTitle,
  settleRunningTools,
  userModelText,
} from '../../common/chat-reducer.js';
import type { PermissionBroker } from './permission-broker.js';
import { sessionNotFound, type SessionStore } from './session-store.js';

/** Ce dont le gestionnaire a besoin d'un agent : exécuter un tour. */
export interface TurnRunner {
  runTurn(options: RunTurnOptions): Promise<TurnResult>;
}

/** Contexte donné à la fabrique d'agent pour un tour. */
export interface RunnerContext {
  sessionId: string;
  workspace: string;
  registry: ToolRegistry;
  requestPermission: PermissionHandler;
  signal: AbortSignal;
}

export interface ChatManagerOptions {
  store: SessionStore;
  permissions: PermissionBroker;
  /** Registre d'outils d'une nouvelle session (natifs, web, MCP…). */
  createRegistry: (sessionId: string) => ToolRegistry;
  /** Agent du tour (lève une `AtelierError` si le serveur n'est pas configuré…). */
  createRunner: (context: RunnerContext) => Promise<TurnRunner>;
  /** Relais des événements (renderer). */
  emit: (event: AgentEvent) => void;
  /** Erreur de tour liée au serveur (pour revérifier l'indicateur). */
  onLlmError?: (error: SerializedAtelierError) => void;
  newId?: () => string;
  now?: () => Date;
}

interface PendingInput {
  text: string;
  attachments: readonly Attachment[];
}

interface SessionRuntime {
  registry: ToolRegistry;
  /** Historique modèle (reconstruit depuis le stockage à la première utilisation). */
  history: ModelMessage[];
  lastInputTokens?: number;
  running?: { turnId: string; controller: AbortController; done: Promise<void> };
  /** Dernier tour en échec ou interrompu : relançable via `agent:retry`. */
  retryable?: { input: PendingInput; history: ModelMessage[] };
}

export class ChatManager {
  readonly #o: ChatManagerOptions;
  readonly #runtimes = new Map<string, SessionRuntime>();

  constructor(options: ChatManagerOptions) {
    this.#o = options;
  }

  list(limit?: number): SessionSummary[] {
    return this.#o.store.list(limit);
  }

  create(workspace: string): SessionSummary {
    const at = this.#now();
    return this.#o.store.create({
      id: this.#id(),
      title: 'Nouvelle conversation',
      workspace,
      createdAt: at,
      updatedAt: at,
    });
  }

  open(sessionId: string): { session: SessionSummary; messages: ChatMessage[] } {
    const session = this.#session(sessionId);
    return { session, messages: this.#o.store.messages(sessionId) };
  }

  /** Vrai si un tour tourne pour cette session. */
  isRunning(sessionId: string): boolean {
    return this.#runtimes.get(sessionId)?.running !== undefined;
  }

  async delete(sessionId: string): Promise<void> {
    await this.stop(sessionId);
    this.#o.permissions.forget(sessionId);
    this.#runtimes.delete(sessionId);
    this.#o.store.delete(sessionId);
  }

  /** Lance un tour ; renvoie son identifiant sans attendre la fin. */
  send(
    sessionId: string,
    text: string,
    attachments: readonly Attachment[] = [],
  ): { turnId: string } {
    const session = this.#session(sessionId);
    if (text.trim() === '' && attachments.length === 0) {
      throw new AtelierError('internal', 'Message vide.', { details: { kind: 'empty_message' } });
    }
    const runtime = this.#runtime(sessionId);
    this.#assertIdle(runtime);

    const at = this.#now();
    const user = createUserMessage({ id: this.#id(), sessionId, text, attachments, createdAt: at });
    this.#o.store.saveMessage(user);
    const isFirst = this.#o.store.messages(sessionId).filter((m) => m.role === 'user').length === 1;
    this.#o.store.update(sessionId, {
      updatedAt: at,
      ...(isFirst ? { title: deriveSessionTitle(text, attachments[0]?.name) } : {}),
    });
    return this.#start(session, runtime, { text, attachments }, runtime.history);
  }

  /** Relance le dernier tour en échec (coupure réseau…) avec la même demande. */
  retry(sessionId: string): { turnId: string } {
    const session = this.#session(sessionId);
    const runtime = this.#runtime(sessionId);
    this.#assertIdle(runtime);
    if (!runtime.retryable) {
      throw new AtelierError('internal', 'Aucun tour à relancer.', {
        details: { kind: 'nothing_to_retry' },
      });
    }
    return this.#start(session, runtime, runtime.retryable.input, runtime.retryable.history);
  }

  /** Bouton stop : annule le tour et refuse les permissions en attente. */
  async stop(sessionId: string): Promise<void> {
    const running = this.#runtimes.get(sessionId)?.running;
    if (!running) return;
    running.controller.abort();
    this.#o.permissions.denyAll(sessionId);
    await running.done;
  }

  /** Arrête tous les tours (fermeture de l'app). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#runtimes.keys()].map((id) => this.stop(id)));
  }

  #start(
    session: SessionSummary,
    runtime: SessionRuntime,
    input: PendingInput,
    history: ModelMessage[],
  ): { turnId: string } {
    const turnId = this.#id();
    const controller = new AbortController();
    runtime.retryable = undefined;
    const done = this.#run(session, runtime, turnId, input, history, controller);
    runtime.running = { turnId, controller, done };
    return { turnId };
  }

  async #run(
    session: SessionSummary,
    runtime: SessionRuntime,
    turnId: string,
    input: PendingInput,
    history: ModelMessage[],
    controller: AbortController,
  ): Promise<void> {
    // Laisse `send` renvoyer le turnId avant le premier événement.
    await Promise.resolve();
    const sessionId = session.id;
    let assistant = createAssistantMessage({ id: this.#id(), sessionId, createdAt: this.#now() });
    const emit = (event: AgentEvent): void => {
      assistant = applyAgentEvent(assistant, event);
      this.#o.emit(event);
    };
    let outcome: TurnResult['reason'] = 'error';
    try {
      const runner = await this.#o.createRunner({
        sessionId,
        workspace: session.workspace,
        registry: runtime.registry,
        requestPermission: this.#o.permissions.handlerFor(sessionId),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        outcome = 'aborted';
        emit({ type: 'done', sessionId, turnId, reason: 'aborted' });
      } else {
        const result = await runner.runTurn({
          sessionId,
          turnId,
          history,
          input: userModelText(input.text, input.attachments),
          emit,
          abortSignal: controller.signal,
          ...(runtime.lastInputTokens !== undefined
            ? { lastInputTokens: runtime.lastInputTokens }
            : {}),
        });
        outcome = result.reason;
        runtime.history = result.messages;
        if (result.usage) runtime.lastInputTokens = result.usage.inputTokens;
        if (result.error?.code.startsWith('llm/')) this.#o.onLlmError?.(result.error);
      }
    } catch (error) {
      const serialized = serializeError(error);
      if (controller.signal.aborted) {
        outcome = 'aborted';
        emit({ type: 'done', sessionId, turnId, reason: 'aborted' });
      } else {
        emit({ type: 'error', sessionId, turnId, error: serialized });
        if (serialized.code.startsWith('llm/')) this.#o.onLlmError?.(serialized);
      }
    } finally {
      assistant = settleRunningTools(assistant);
      if (assistant.parts.length > 0) this.#o.store.saveMessage(assistant);
      if (this.#o.store.get(sessionId)) this.#o.store.update(sessionId, { updatedAt: this.#now() });
      if (outcome === 'error' || outcome === 'aborted') runtime.retryable = { input, history };
      runtime.running = undefined;
    }
  }

  #assertIdle(runtime: SessionRuntime): void {
    if (runtime.running) {
      throw new AtelierError('internal', 'Un tour est déjà en cours dans cette conversation.', {
        details: { kind: 'turn_in_progress' },
      });
    }
  }

  #session(sessionId: string): SessionSummary {
    const session = this.#o.store.get(sessionId);
    if (!session) throw sessionNotFound(sessionId);
    return session;
  }

  #runtime(sessionId: string): SessionRuntime {
    let runtime = this.#runtimes.get(sessionId);
    if (!runtime) {
      runtime = {
        registry: this.#o.createRegistry(sessionId),
        history: chatMessagesToModelMessages(this.#o.store.messages(sessionId)),
      };
      this.#runtimes.set(sessionId, runtime);
    }
    return runtime;
  }

  #id(): string {
    return (this.#o.newId ?? randomUUID)();
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }
}
