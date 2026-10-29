/**
 * Sessions de chat côté main : un tour à la fois par session, relais des events
 * vers le renderer, persistance (messages affichés + historique modèle), stop
 * et reprise.
 *
 * Chaque session de chat garde une session agent (`createAgentRuntime` →
 * `createSession`), recréée entre deux tours si le runtime a changé (Réglages
 * LLM modifiés) ou pour rejouer un tour en échec.
 */
import { randomUUID } from 'node:crypto';
import { chatMessagesToModelMessages, type TurnResult } from '@atelier/agent-core';
import {
  AtelierError,
  serializeError,
  type AgentEvent,
  type AgentEventSink,
  type Attachment,
  type ChatMessage,
  type FileCard,
  type PermissionHandler,
  type SerializedAtelierError,
  type SessionSummary,
  type ToolDisplay,
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
import { WorkspaceChangeTracker } from './workspace-changes.js';

/** Ce que le gestionnaire utilise d'une `AgentSession` d'agent-core. */
export interface AgentSessionLike {
  readonly history: readonly ModelMessage[];
  /** `inputTokens` du dernier tour (déclenchement de la compaction après recréation). */
  readonly lastInputTokens?: number | undefined;
  send(
    input: string,
    emit: AgentEventSink,
    abortSignal?: AbortSignal,
    options?: { turnId?: string },
  ): Promise<TurnResult>;
}

/** Paramètres d'une nouvelle session agent. */
export interface NewAgentSession {
  sessionId: string;
  workspace: string;
  requestPermission: PermissionHandler;
  history: readonly ModelMessage[];
  /** Reprise d'une session recréée : la compaction reste déclenchée à temps. */
  lastInputTokens?: number;
}

/** Fabrique de sessions agent (runtime courant). */
export interface AgentSessionFactory {
  /** Change quand le runtime est recréé (Réglages LLM). */
  generation(): number;
  /** Prépare le tour : VM montée sur le dossier, skills relus… */
  beforeTurn(sessionId: string, workspace: string): Promise<void>;
  /** Crée une session agent ; rejette une `AtelierError` (serveur non configuré…). */
  createSession(options: NewAgentSession): Promise<AgentSessionLike>;
}

export interface ChatManagerOptions {
  store: SessionStore;
  permissions: PermissionBroker;
  agents: AgentSessionFactory;
  /** Relais des événements (renderer). */
  emit: (event: AgentEvent) => void;
  /** Erreur de tour liée au serveur (pour revérifier l'indicateur). */
  onLlmError?: (error: SerializedAtelierError) => void;
  /** Suivi des fichiers produits pendant le tour (défaut : photo du dossier de travail). */
  trackChanges?: (workspace: string) => ChangeTracker;
  newId?: () => string;
  now?: () => Date;
}

/** Ce que le gestionnaire utilise du suivi des fichiers (voir `WorkspaceChangeTracker`). */
export interface ChangeTracker {
  start(): Promise<void>;
  afterTool(display: ToolDisplay | undefined): Promise<FileCard[]>;
}

interface PendingInput {
  text: string;
  attachments: readonly Attachment[];
}

interface SessionRuntime {
  /** Session agent et génération du runtime qui l'a créée. */
  agent?: { session: AgentSessionLike; generation: number };
  running?: { turnId: string; controller: AbortController; done: Promise<void> };
  /** Dernier tour en échec ou interrompu : relançable via `agent:retry`. */
  retryable?: { input: PendingInput; history: readonly ModelMessage[] };
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
      throw new AtelierError('tool/invalid_input', 'Message vide.');
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
    return this.#start(session, runtime, { text, attachments }, undefined);
  }

  /** Relance le dernier tour en échec (coupure réseau…) avec la même demande. */
  retry(sessionId: string): { turnId: string } {
    const session = this.#session(sessionId);
    const runtime = this.#runtime(sessionId);
    this.#assertIdle(runtime);
    const retryable = runtime.retryable;
    if (!retryable) {
      throw new AtelierError('internal', 'Aucun tour à relancer.', {
        details: { kind: 'nothing_to_retry' },
      });
    }
    return this.#start(session, runtime, retryable.input, retryable.history);
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

  /**
   * @param resetHistory - Historique à rétablir avant le tour (reprise d'un tour
   *   en échec) ; sinon celui de la session agent courante.
   */
  #start(
    session: SessionSummary,
    runtime: SessionRuntime,
    input: PendingInput,
    resetHistory: readonly ModelMessage[] | undefined,
  ): { turnId: string } {
    const turnId = this.#id();
    const controller = new AbortController();
    runtime.retryable = undefined;
    const done = this.#run(session, runtime, turnId, input, resetHistory, controller);
    runtime.running = { turnId, controller, done };
    return { turnId };
  }

  async #run(
    session: SessionSummary,
    runtime: SessionRuntime,
    turnId: string,
    input: PendingInput,
    resetHistory: readonly ModelMessage[] | undefined,
    controller: AbortController,
  ): Promise<void> {
    // Laisse `send` renvoyer le turnId avant le premier événement.
    await Promise.resolve();
    const sessionId = session.id;
    let assistant = createAssistantMessage({ id: this.#id(), sessionId, createdAt: this.#now() });
    const forward = (event: AgentEvent): void => {
      assistant = applyAgentEvent(assistant, event);
      this.#o.emit(event);
    };
    const tracker = (this.#o.trackChanges ?? defaultTracker)(session.workspace);
    // File d'attente : l'ordre des événements est conservé pendant la photo du
    // dossier qui suit chaque outil (cartes des fichiers produits dans la VM…).
    let queue = Promise.resolve();
    const emit = (event: AgentEvent): void => {
      queue = queue.then(async () => {
        forward(event);
        if (event.type !== 'tool_result' || event.denied) return;
        const files = await tracker.afterTool(event.display).catch(() => []);
        if (files.length > 0) {
          forward({ type: 'tool_files', sessionId, turnId, toolCallId: event.toolCallId, files });
        }
      });
      // Un relais en échec ne doit pas bloquer les événements suivants.
      queue = queue.catch(() => undefined);
    };
    const historyBefore = resetHistory ?? this.#currentHistory(runtime, sessionId);
    let outcome: TurnResult['reason'] = 'error';
    try {
      await this.#o.agents.beforeTurn(sessionId, session.workspace);
      await tracker.start().catch(() => undefined);
      const agent = await this.#agentSession(session, runtime, resetHistory);
      if (controller.signal.aborted) {
        outcome = 'aborted';
        emit({ type: 'done', sessionId, turnId, reason: 'aborted' });
      } else {
        const result = await agent.send(
          userModelText(input.text, input.attachments),
          emit,
          controller.signal,
          { turnId },
        );
        outcome = result.reason;
        // Historique modèle fidèle (compaction, paires outil/résultat) pour la reprise.
        this.#o.store.saveModelHistory(sessionId, result.messages);
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
      await queue;
      assistant = settleRunningTools(assistant);
      if (assistant.parts.length > 0) this.#o.store.saveMessage(assistant);
      if (this.#o.store.get(sessionId)) this.#o.store.update(sessionId, { updatedAt: this.#now() });
      if (outcome === 'error' || outcome === 'aborted') {
        runtime.retryable = { input, history: historyBefore };
      }
      runtime.running = undefined;
    }
  }

  /**
   * Session agent du tour : réutilisée si le runtime n'a pas changé, sinon
   * recréée avec l'historique courant (ou celui à rétablir).
   */
  async #agentSession(
    session: SessionSummary,
    runtime: SessionRuntime,
    resetHistory: readonly ModelMessage[] | undefined,
  ): Promise<AgentSessionLike> {
    const generation = this.#o.agents.generation();
    if (runtime.agent && runtime.agent.generation === generation && !resetHistory) {
      return runtime.agent.session;
    }
    // Recréation après un changement de runtime : on garde la consommation du dernier tour.
    const lastInputTokens = resetHistory ? undefined : runtime.agent?.session.lastInputTokens;
    const created = await this.#o.agents.createSession({
      sessionId: session.id,
      workspace: session.workspace,
      requestPermission: this.#o.permissions.handlerFor(session.id),
      history: resetHistory ?? this.#currentHistory(runtime, session.id),
      ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
    });
    runtime.agent = { session: created, generation };
    return created;
  }

  /** Historique modèle : session agent, sinon persisté, sinon reconstruit depuis l'affichage. */
  #currentHistory(runtime: SessionRuntime, sessionId: string): readonly ModelMessage[] {
    if (runtime.agent) return runtime.agent.session.history;
    return (
      this.#o.store.modelHistory(sessionId) ??
      chatMessagesToModelMessages(
        // Le message utilisateur du tour en cours est déjà enregistré : on l'exclut.
        this.#withoutTrailingUser(this.#o.store.messages(sessionId)),
      )
    );
  }

  #withoutTrailingUser(messages: ChatMessage[]): ChatMessage[] {
    return messages.at(-1)?.role === 'user' ? messages.slice(0, -1) : messages;
  }

  #assertIdle(runtime: SessionRuntime): void {
    if (runtime.running) {
      throw new AtelierError('agent/busy', 'Un tour est déjà en cours dans cette conversation.');
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
      runtime = {};
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

function defaultTracker(workspace: string): ChangeTracker {
  return new WorkspaceChangeTracker(workspace);
}
