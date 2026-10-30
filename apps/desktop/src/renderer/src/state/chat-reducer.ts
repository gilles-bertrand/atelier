/**
 * État des conversations côté renderer, construit à partir des messages
 * persistés (`session:open`) et des `AgentEvent` en direct. Pur et testable.
 *
 * Le message assistant du tour en cours (`live`) est construit avec le même
 * réducteur que le main (`applyAgentEvent`) ; à la fin du tour, il rejoint
 * l'historique.
 */
import type {
  AgentEvent,
  ChatMessage,
  PermissionRequest,
  SerializedAtelierError,
  TodoItem,
} from '@atelier/shared';
import {
  applyAgentEvent,
  createAssistantMessage,
  latestTodos,
  settleRunningTools,
} from '../../../common/chat-reducer';

export type TurnStatus = 'running' | 'done' | 'aborted' | 'error';

export interface TurnView {
  turnId: string;
  status: TurnStatus;
  error?: SerializedAtelierError;
  /** Nouvelle tentative en cours vers le serveur. */
  retry?: { attempt: number; maxAttempts?: number };
  /** Messages résumés par une compaction pendant le tour. */
  compacted?: number;
  /** Fin anormale mais sans erreur (`max_steps`, `length`). */
  stopReason?: 'max_steps' | 'length';
}

export interface SessionView {
  /** Messages terminés (persistés ou tours finis). */
  messages: ChatMessage[];
  /** Message assistant du tour en cours. */
  live?: ChatMessage;
  turn?: TurnView;
  /** Dernière liste de tâches non vide. */
  todos: TodoItem[];
  /** Demandes de permission en attente (la première est affichée). */
  permissions: PermissionRequest[];
  loaded: boolean;
}

export type ChatState = Readonly<Record<string, SessionView>>;

export type ChatAction =
  | { type: 'loaded'; sessionId: string; messages: ChatMessage[] }
  | { type: 'user_sent'; message: ChatMessage }
  | { type: 'turn_started'; sessionId: string; turnId: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'permission_answered'; sessionId: string; requestId: string }
  | { type: 'forget'; sessionId: string };

const emptySession = (): SessionView => ({
  messages: [],
  todos: [],
  permissions: [],
  loaded: false,
});

function withSession(
  state: ChatState,
  sessionId: string,
  update: (session: SessionView) => SessionView,
): ChatState {
  return { ...state, [sessionId]: update(state[sessionId] ?? emptySession()) };
}

/** Termine le tour : le message en direct rejoint l'historique. */
function finishLive(session: SessionView): SessionView {
  if (!session.live) return session;
  const live = settleRunningTools(session.live);
  const { live: _done, ...rest } = session;
  return live.parts.length > 0 ? { ...rest, messages: [...session.messages, live] } : rest;
}

function applyEvent(session: SessionView, event: AgentEvent): SessionView {
  const turn: TurnView =
    session.turn?.turnId === event.turnId
      ? session.turn
      : { turnId: event.turnId, status: 'running' };
  const live =
    session.live?.id === `live-${event.turnId}`
      ? session.live
      : createAssistantMessage({
          id: `live-${event.turnId}`,
          sessionId: event.sessionId,
          createdAt: new Date().toISOString(),
        });
  const next: SessionView = { ...session, turn, live: applyAgentEvent(live, event) };

  switch (event.type) {
    case 'text_delta':
    case 'reasoning_delta':
    case 'tool_start':
    case 'tool_display':
    case 'tool_files':
    case 'sources':
      // Le serveur répond : plus de « reconnexion » affichée.
      return turn.retry ? { ...next, turn: withoutRetry(turn) } : next;
    case 'tool_result':
      return {
        ...next,
        // Une permission devenue sans objet (outil terminé) disparaît.
        permissions: next.permissions.filter((p) => p.toolCallId !== event.toolCallId),
      };
    case 'todo_update':
      return event.todos.length > 0 ? { ...next, todos: event.todos } : next;
    case 'permission_request':
      return { ...next, permissions: [...next.permissions, event.request] };
    case 'llm_retry':
      return {
        ...next,
        turn: {
          ...turn,
          retry: {
            attempt: event.attempt,
            ...(event.maxAttempts !== undefined ? { maxAttempts: event.maxAttempts } : {}),
          },
        },
      };
    case 'usage':
      // Jauge de contexte : état isolé, hors du reducer des messages.
      return session;
    case 'compaction':
      return {
        ...next,
        turn: { ...turn, compacted: (turn.compacted ?? 0) + event.replacedMessages },
      };
    case 'done': {
      const finished = finishLive(next);
      const base = withoutRetry(turn);
      return {
        ...finished,
        permissions: [],
        turn: {
          ...base,
          status: event.reason === 'aborted' ? 'aborted' : 'done',
          ...(event.reason === 'max_steps' || event.reason === 'length'
            ? { stopReason: event.reason }
            : {}),
        },
      };
    }
    case 'error':
      return {
        ...finishLive(next),
        permissions: [],
        turn: { ...withoutRetry(turn), status: 'error', error: event.error },
      };
  }
}

function withoutRetry(turn: TurnView): TurnView {
  const { retry: _retry, ...rest } = turn;
  return rest;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'loaded':
      return withSession(state, action.sessionId, (session) => ({
        ...session,
        // Un tour en cours (events reçus avant l'ouverture) reste affiché en direct.
        messages: action.messages,
        todos: latestTodos(action.messages),
        loaded: true,
      }));
    case 'user_sent':
      return withSession(state, action.message.sessionId, (session) => ({
        ...session,
        messages: [...session.messages, action.message],
      }));
    case 'turn_started':
      return withSession(state, action.sessionId, (session) =>
        session.turn?.turnId === action.turnId
          ? session
          : { ...session, turn: { turnId: action.turnId, status: 'running' } },
      );
    case 'event':
      return withSession(state, action.event.sessionId, (session) =>
        applyEvent(session, action.event),
      );
    case 'permission_answered':
      return withSession(state, action.sessionId, (session) => ({
        ...session,
        permissions: session.permissions.filter((p) => p.id !== action.requestId),
      }));
    case 'forget': {
      const { [action.sessionId]: _removed, ...rest } = state;
      return rest;
    }
  }
}

/** Vrai si un tour tourne dans la session. */
export function isRunning(session: SessionView | undefined): boolean {
  return session?.turn?.status === 'running';
}
