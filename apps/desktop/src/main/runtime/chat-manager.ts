/**
 * Sessions de chat côté main : un tour à la fois par session, relais des events
 * vers le renderer, persistance (messages affichés + historique modèle), stop
 * et reprise.
 *
 * Chaque session de chat garde une session agent (`createAgentRuntime` →
 * `createSession`), recréée entre deux tours si le runtime a changé (Réglages
 * LLM modifiés), si le modèle de la conversation a changé (#13) ou pour
 * rejouer un tour en échec.
 *
 * Modèle d'une conversation (D1 de #13) : celui de la session s'il est choisi,
 * sinon le modèle par défaut des Réglages (conversations antérieures à #13).
 */
import { randomUUID } from 'node:crypto';
import { chatMessagesToModelMessages, type TurnResult } from '@atelier/agent-core';
import {
  type AgentEvent,
  type AgentEventSink,
  AtelierError,
  type Attachment,
  type ChatMessage,
  type FileCard,
  type PermissionHandler,
  type SerializedAtelierError,
  serializeError,
  type SessionSummary,
  type TokenUsage,
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
import { usageRecord, type UsageStore } from './usage-store.js';
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
  /** Modèle de la conversation : runtime, fenêtre de contexte et vision propres à ce modèle. */
  model: string;
  requestPermission: PermissionHandler;
  history: readonly ModelMessage[];
  /** Reprise d'une session recréée : la compaction reste déclenchée à temps. */
  lastInputTokens?: number;
}

/** Ce que le gestionnaire utilise du catalogue des modèles (`ModelCatalog`). */
export interface ModelValidator {
  /** Rejette `llm/model_not_found` (absent du serveur) ou `llm/model_unsupported` (sans outils). */
  assertUsable(model: string): Promise<void>;
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
  /** Registre de consommation (une ligne par tour, ADR-001). */
  usage?: UsageStore;
  /**
   * Modèle par défaut des Réglages : copié dans chaque nouvelle conversation, et
   * suivi par les conversations sans modèle (créées avant #13).
   */
  defaultModel?: () => string;
  /** Validation du modèle choisi pour une conversation (`session:set-model`). */
  models?: ModelValidator;
  /** Journal des erreurs non bloquantes (registre de consommation…). */
  log?: (message: string, data?: unknown) => void;
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
  /** Session agent, génération du runtime qui l'a créée et modèle qu'elle utilise. */
  agent?: { session: AgentSessionLike; generation: number; model: string };
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
    // Copie du modèle par défaut : le changer ensuite dans les Réglages ne modifie pas cette conversation.
    const model = this.#o.defaultModel?.() ?? '';
    return this.#o.store.create({
      id: this.#id(),
      title: 'Nouvelle conversation',
      workspace,
      createdAt: at,
      updatedAt: at,
      ...(model !== '' ? { model } : {}),
    });
  }

  /**
   * Change le modèle de la conversation, utilisé à partir du tour suivant (D1).
   * `null` : retour au modèle par défaut des Réglages. Refusé pendant un tour.
   */
  async setModel(sessionId: string, model: string | null): Promise<SessionSummary> {
    const session = this.#session(sessionId);
    const runtime = this.#runtime(sessionId);
    this.#assertIdle(runtime);
    const name = model === null ? null : model.trim();
    if (name === '') throw new AtelierError('tool/invalid_input', 'Nom de modèle vide.');
    if (name === (session.model ?? null)) return session;
    if (name !== null) await this.#o.models?.assertUsable(name);
    // Un tour a pu démarrer pendant la vérification auprès du serveur.
    this.#assertIdle(runtime);
    return this.#o.store.update(sessionId, { model: name });
  }

  /** Messages affichés et dernier usage connu (jauge de contexte dès la réouverture). */
  open(sessionId: string): {
    session: SessionSummary;
    messages: ChatMessage[];
    usage?: TokenUsage;
  } {
    const session = this.#session(sessionId);
    const usage = this.#safeUsage(() => this.#o.usage?.lastForSession(sessionId));
    return {
      session,
      messages: this.#o.store.messages(sessionId),
      ...(usage ? { usage } : {}),
    };
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
    // Les tours restent comptés dans les statistiques, sans lien vers la conversation.
    this.#safeUsage(() => {
      this.#o.usage?.detachSession(sessionId);
    });
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
    // Modèle de la conversation au moment du tour : en changer ensuite ne réattribue rien.
    const model = this.#modelOf(session);
    let assistant = createAssistantMessage({
      id: this.#id(),
      sessionId,
      createdAt: this.#now(),
      ...(model !== '' ? { model } : {}),
    });
    let compactions = 0;
    const forward = (event: AgentEvent): void => {
      if (event.type === 'compaction') compactions += 1;
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
      const agent = await this.#agentSession(session, runtime, resetHistory, model);
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
        await queue;
        // `TurnResult.usage` fait foi (présent aussi en erreur, sans event `done`).
        if (result.usage) this.#recordUsage(turnId, sessionId, model, result, compactions);
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

  #recordUsage(
    turnId: string,
    sessionId: string,
    model: string,
    result: TurnResult,
    compactions: number,
  ): void {
    const usage: TokenUsage | undefined = result.usage;
    if (!usage) return;
    this.#safeUsage(() => {
      this.#o.usage?.record(
        usageRecord({
          turnId,
          sessionId,
          model,
          outcome: result.reason,
          usage,
          compactions,
          at: this.#o.now?.() ?? new Date(),
        }),
      );
    });
  }

  /** Le registre ne doit jamais faire échouer un tour ni l'ouverture d'une conversation. */
  #safeUsage<T>(task: () => T): T | undefined {
    try {
      return task();
    } catch (error) {
      this.#o.log?.('registre de consommation indisponible', error);
      return undefined;
    }
  }

  /**
   * Session agent du tour : réutilisée si ni le runtime ni le modèle n'ont
   * changé, sinon recréée avec l'historique courant (ou celui à rétablir).
   */
  async #agentSession(
    session: SessionSummary,
    runtime: SessionRuntime,
    resetHistory: readonly ModelMessage[] | undefined,
    model: string,
  ): Promise<AgentSessionLike> {
    const generation = this.#o.agents.generation();
    const current = runtime.agent;
    if (current && current.generation === generation && current.model === model && !resetHistory) {
      return current.session;
    }
    // Recréation (Réglages LLM ou modèle changés) : la consommation du dernier tour
    // suit, pour que la compaction passe avant l'appel si la fenêtre du nouveau
    // modèle est plus petite.
    const lastInputTokens = resetHistory ? undefined : current?.session.lastInputTokens;
    const created = await this.#o.agents.createSession({
      sessionId: session.id,
      workspace: session.workspace,
      model,
      requestPermission: this.#o.permissions.handlerFor(session.id),
      history: resetHistory ?? this.#currentHistory(runtime, session.id),
      ...(lastInputTokens !== undefined ? { lastInputTokens } : {}),
    });
    runtime.agent = { session: created, generation, model };
    return created;
  }

  /** Modèle de la conversation, sinon le modèle par défaut des Réglages. */
  #modelOf(session: SessionSummary): string {
    return session.model ?? this.#o.defaultModel?.() ?? '';
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
