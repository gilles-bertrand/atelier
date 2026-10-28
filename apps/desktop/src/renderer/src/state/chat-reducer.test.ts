import { describe, expect, it } from 'vitest';
import type { AgentEvent, ChatMessage, PermissionRequest } from '@atelier/shared';
import { chatReducer, isRunning, type ChatState } from './chat-reducer';

const ev = { sessionId: 's1', turnId: 't1' } as const;
const run = (events: AgentEvent[], initial: ChatState = {}): ChatState =>
  events.reduce((state, event) => chatReducer(state, { type: 'event', event }), initial);

const permission: PermissionRequest = {
  id: 'p1',
  sessionId: 's1',
  toolCallId: 'c1',
  toolName: 'write_file',
  kind: 'file_write',
  title: 'Écrire recap.md',
  input: {},
};

describe('chatReducer', () => {
  it('construit le message en direct puis le range dans l’historique à la fin du tour', () => {
    const during = run([
      { ...ev, type: 'text_delta', delta: 'Bon' },
      { ...ev, type: 'text_delta', delta: 'jour' },
    ]);
    expect(isRunning(during['s1'])).toBe(true);
    expect(during['s1']?.live?.parts).toEqual([{ type: 'text', text: 'Bonjour' }]);

    const after = run([{ ...ev, type: 'done', reason: 'stop' }], during);
    expect(after['s1']?.live).toBeUndefined();
    expect(after['s1']?.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Bonjour' }]);
    expect(after['s1']?.turn).toMatchObject({ status: 'done' });
  });

  it('gère permissions, reconnexion, tâches et erreur', () => {
    let state = run([
      { ...ev, type: 'llm_retry', attempt: 2, maxAttempts: 4, delayMs: 1000, reason: 'HTTP 503' },
    ]);
    expect(state['s1']?.turn?.retry).toEqual({ attempt: 2, maxAttempts: 4 });
    state = run(
      [
        { ...ev, type: 'tool_start', toolCallId: 'c1', toolName: 'write_file', input: {} },
        { ...ev, type: 'permission_request', request: permission },
        {
          ...ev,
          type: 'todo_update',
          todos: [{ id: '1', title: 'Lire', status: 'in_progress' }],
        },
      ],
      state,
    );
    expect(state['s1']?.turn?.retry).toBeUndefined();
    expect(state['s1']?.permissions).toEqual([permission]);
    expect(state['s1']?.todos).toHaveLength(1);
    // Une liste vidée ne remplace pas la dernière liste affichée.
    state = run([{ ...ev, type: 'todo_update', todos: [] }], state);
    expect(state['s1']?.todos).toHaveLength(1);

    state = run(
      [{ ...ev, type: 'error', error: { code: 'llm/unreachable', message: 'x', retryable: true } }],
      state,
    );
    expect(state['s1']?.permissions).toEqual([]);
    expect(state['s1']?.turn).toMatchObject({
      status: 'error',
      error: { code: 'llm/unreachable' },
    });
    // L'outil interrompu n'est pas laissé « en cours ».
    expect(state['s1']?.messages.at(-1)?.parts[0]).toMatchObject({ status: 'error' });
  });

  it('charge l’historique sans perdre un tour en cours, et oublie une session', () => {
    const persisted: ChatMessage[] = [
      {
        id: 'u',
        sessionId: 's1',
        role: 'user',
        parts: [{ type: 'text', text: 'Q' }],
        createdAt: '',
      },
    ];
    let state = run([{ ...ev, type: 'text_delta', delta: 'en cours' }]);
    state = chatReducer(state, { type: 'loaded', sessionId: 's1', messages: persisted });
    expect(state['s1']?.messages).toEqual(persisted);
    expect(state['s1']?.live?.parts).toHaveLength(1);
    expect(state['s1']?.loaded).toBe(true);
    state = chatReducer(state, { type: 'forget', sessionId: 's1' });
    expect(state['s1']).toBeUndefined();
  });

  it('retire la permission répondue et celles d’un outil terminé', () => {
    let state = run([{ ...ev, type: 'permission_request', request: permission }]);
    state = chatReducer(state, { type: 'permission_answered', sessionId: 's1', requestId: 'p1' });
    expect(state['s1']?.permissions).toEqual([]);
    state = run(
      [
        { ...ev, type: 'permission_request', request: permission },
        {
          ...ev,
          type: 'tool_result',
          toolCallId: 'c1',
          toolName: 'write_file',
          ok: false,
          denied: true,
          output: 'refusé',
        },
      ],
      state,
    );
    expect(state['s1']?.permissions).toEqual([]);
  });
});
