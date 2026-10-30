/**
 * Magasin des conversations : abonné en permanence à `agent:event` (un tour
 * continue même si l'utilisateur revient à l'accueil), actions IPC du chat.
 */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import type { Attachment, PermissionDecision, PermissionRequest } from '@atelier/shared';
import { createUserMessage } from '../../../common/chat-reducer';
import { atelier, call } from '@renderer/lib/api';
import { chatReducer, type ChatState, type SessionView } from './chat-reducer';
import { SessionUsageProvider, SessionUsageStore } from './usage-store';

export interface ChatActions {
  /** Charge l'historique d'une session (une seule fois). */
  open(sessionId: string): Promise<void>;
  send(sessionId: string, text: string, attachments: readonly Attachment[]): Promise<void>;
  stop(sessionId: string): Promise<void>;
  retry(sessionId: string): Promise<void>;
  respond(request: PermissionRequest, decision: PermissionDecision): Promise<void>;
  forget(sessionId: string): void;
}

interface ChatContextValue {
  state: ChatState;
  actions: ChatActions;
}

const ChatContext = createContext<ChatContextValue | null>(null);

let localIds = 0;

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, {});
  const [usage] = useState(() => new SessionUsageStore());

  useEffect(
    () =>
      atelier().on('agent:event', (event) => {
        // Usage (jauge) : magasin isolé, la conversation n'est pas re-rendue.
        if (event.type === 'usage') {
          usage.set(event.sessionId, event.usage);
          return;
        }
        dispatch({ type: 'event', event });
      }),
    [usage],
  );

  const open = useCallback(
    async (sessionId: string) => {
      const opened = await call('session:open', { sessionId });
      if (opened.usage) usage.set(sessionId, opened.usage);
      dispatch({ type: 'loaded', sessionId, messages: opened.messages });
    },
    [usage],
  );

  const send = useCallback(
    async (sessionId: string, text: string, attachments: readonly Attachment[]) => {
      localIds += 1;
      dispatch({
        type: 'user_sent',
        message: createUserMessage({
          id: `local-${String(localIds)}`,
          sessionId,
          text,
          attachments,
          createdAt: new Date().toISOString(),
        }),
      });
      const { turnId } = await call('agent:send', {
        sessionId,
        text,
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      });
      dispatch({ type: 'turn_started', sessionId, turnId });
    },
    [],
  );

  const stop = useCallback(async (sessionId: string) => {
    await call('agent:stop', { sessionId });
  }, []);

  const retry = useCallback(async (sessionId: string) => {
    const { turnId } = await call('agent:retry', { sessionId });
    dispatch({ type: 'turn_started', sessionId, turnId });
  }, []);

  const respond = useCallback(async (request: PermissionRequest, decision: PermissionDecision) => {
    dispatch({ type: 'permission_answered', sessionId: request.sessionId, requestId: request.id });
    await call('permission:respond', { requestId: request.id, decision });
  }, []);

  const forget = useCallback(
    (sessionId: string) => {
      usage.forget(sessionId);
      dispatch({ type: 'forget', sessionId });
    },
    [usage],
  );

  const value = useMemo<ChatContextValue>(
    () => ({ state, actions: { open, send, stop, retry, respond, forget } }),
    [state, open, send, stop, retry, respond, forget],
  );
  return (
    <ChatContext value={value}>
      <SessionUsageProvider store={usage}>{children}</SessionUsageProvider>
    </ChatContext>
  );
}

export function useChat(): ChatContextValue {
  const value = use(ChatContext);
  if (!value) throw new Error('useChat hors de <ChatProvider>');
  return value;
}

/** Vue d'une session (vide tant qu'elle n'est pas chargée). */
export function useSessionView(sessionId: string): SessionView {
  const { state } = useChat();
  return state[sessionId] ?? { messages: [], todos: [], permissions: [], loaded: false };
}
