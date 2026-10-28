import { describe, expect, it } from 'vitest';
import type { TurnResult } from '@atelier/agent-core';
import type { AgentEvent, AgentEventSink } from '@atelier/shared';
import type { ModelMessage } from 'ai';
import {
  ChatManager,
  type AgentSessionFactory,
  type AgentSessionLike,
  type NewAgentSession,
} from './chat-manager.js';
import { PermissionBroker } from './permission-broker.js';
import { InMemorySessionStore } from './session-store.js';

type Mode = 'ok' | 'error' | 'hang';

interface SentTurn {
  input: string;
  turnId: string | undefined;
  history: readonly ModelMessage[];
}

/** Session agent factice (même contrat que l'AgentSession d'agent-core). */
class FakeAgentSession implements AgentSessionLike {
  history: readonly ModelMessage[];
  lastInputTokens: number | undefined;
  constructor(
    readonly options: NewAgentSession,
    private readonly mode: () => Mode,
    private readonly sent: SentTurn[],
  ) {
    this.history = options.history;
  }

  async send(
    input: string,
    emit: AgentEventSink,
    abortSignal?: AbortSignal,
    options?: { turnId?: string },
  ): Promise<TurnResult> {
    const turnId = options?.turnId ?? 'x';
    this.sent.push({ input, turnId: options?.turnId, history: this.history });
    const ev = { sessionId: this.options.sessionId, turnId };
    const withUser: ModelMessage[] = [...this.history, { role: 'user', content: input }];
    const mode = this.mode();
    if (mode === 'hang') {
      emit({ ...ev, type: 'tool_start', toolCallId: 'c1', toolName: 'bash', input: {} });
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener('abort', () => {
          resolve();
        });
      });
      emit({ ...ev, type: 'done', reason: 'aborted' });
      this.history = withUser;
      return { messages: withUser, reason: 'aborted' };
    }
    if (mode === 'error') {
      const error = { code: 'llm/unreachable' as const, message: 'down', retryable: true };
      emit({ ...ev, type: 'error', error });
      this.history = withUser;
      return { messages: withUser, reason: 'error', error };
    }
    emit({ ...ev, type: 'text_delta', delta: 'Bonjour !' });
    emit({ ...ev, type: 'done', reason: 'stop' });
    this.history = [...withUser, { role: 'assistant', content: 'Bonjour !' }];
    this.lastInputTokens = 100;
    return {
      messages: [...this.history],
      reason: 'stop',
      usage: { inputTokens: 100, outputTokens: 5 },
    };
  }
}

function setup(mode: () => Mode, failCreate = false) {
  const events: AgentEvent[] = [];
  const llmErrors: string[] = [];
  const sent: SentTurn[] = [];
  const created: NewAgentSession[] = [];
  const prepared: string[] = [];
  let generation = 0;
  const agents: AgentSessionFactory = {
    generation: () => generation,
    beforeTurn: (sessionId, workspace) => {
      prepared.push(`${sessionId}@${workspace}`);
      return Promise.resolve();
    },
    createSession: (options) => {
      if (failCreate) return Promise.reject(new Error('pas de serveur'));
      created.push(options);
      return Promise.resolve(new FakeAgentSession(options, mode, sent));
    },
  };
  const store = new InMemorySessionStore();
  let n = 0;
  const chats = new ChatManager({
    store,
    permissions: new PermissionBroker(),
    agents,
    emit: (e) => events.push(e),
    onLlmError: (e) => llmErrors.push(e.code),
    newId: () => `id${String((n += 1))}`,
    now: () => new Date('2026-10-28T10:00:00.000Z'),
  });
  const wait = async (sessionId: string): Promise<void> => {
    while (chats.isRunning(sessionId)) await new Promise((r) => setTimeout(r, 1));
  };
  const bump = (): void => {
    generation += 1;
  };
  return { chats, store, events, llmErrors, sent, created, prepared, wait, bump };
}

describe('ChatManager', () => {
  it('exécute un tour, relaie les events et persiste messages et historique modèle', async () => {
    const { chats, store, events, sent, prepared, wait } = setup(() => 'ok');
    const session = chats.create('/w');
    const { turnId } = chats.send(session.id, 'Salut, aide-moi');
    await wait(session.id);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done']);
    expect(events[0]?.turnId).toBe(turnId);
    expect(sent[0]).toMatchObject({ input: 'Salut, aide-moi', turnId, history: [] });
    expect(prepared).toEqual([`${session.id}@/w`]);
    const { session: opened, messages } = chats.open(session.id);
    expect(opened.title).toBe('Salut, aide-moi');
    expect(messages.map((m) => [m.role, m.parts[0]])).toEqual([
      ['user', { type: 'text', text: 'Salut, aide-moi' }],
      ['assistant', { type: 'text', text: 'Bonjour !' }],
    ]);
    expect(store.modelHistory(session.id)).toHaveLength(2);
  });

  it('garde la session agent entre deux tours et la recrée quand le runtime change', async () => {
    const { chats, created, sent, wait, bump } = setup(() => 'ok');
    const session = chats.create('/w');
    chats.send(session.id, 'Un');
    await wait(session.id);
    chats.send(session.id, 'Deux');
    await wait(session.id);
    expect(created).toHaveLength(1);
    bump();
    chats.send(session.id, 'Trois');
    await wait(session.id);
    expect(created).toHaveLength(2);
    // La nouvelle session reprend l'historique complet.
    expect(created[1]?.history).toHaveLength(4);
    expect(created[1]?.lastInputTokens).toBe(100);
    expect(sent[2]?.history).toHaveLength(4);
  });

  it('reprend une session depuis l’historique persisté (repli : messages affichés)', async () => {
    const { chats, store, created, wait } = setup(() => 'ok');
    const session = chats.create('/w');
    store.saveMessage({
      id: 'old-u',
      sessionId: session.id,
      role: 'user',
      parts: [{ type: 'text', text: 'Avant' }],
      createdAt: '',
    });
    store.saveMessage({
      id: 'old-a',
      sessionId: session.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Réponse' }],
      createdAt: '',
    });
    chats.send(session.id, 'Après');
    await wait(session.id);
    // Reconstruit depuis l'affichage, sans le message du tour en cours.
    expect(created[0]?.history).toEqual([
      { role: 'user', content: 'Avant' },
      { role: 'assistant', content: [{ type: 'text', text: 'Réponse' }] },
    ]);
  });

  it('refuse un second tour simultané et arrête proprement', async () => {
    const { chats, store, events, wait } = setup(() => 'hang');
    const session = chats.create('/w');
    chats.send(session.id, 'Long');
    expect(() => chats.send(session.id, 'Encore')).toThrow(/déjà en cours/);
    await new Promise((r) => setTimeout(r, 5));
    await chats.stop(session.id);
    await wait(session.id);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'aborted' });
    // L'outil interrompu n'est pas persisté « en cours ».
    expect(store.messages(session.id).at(-1)?.parts[0]).toMatchObject({ status: 'error' });
  });

  it('relance un tour en erreur avec la même demande et l’historique d’avant', async () => {
    let mode: Mode = 'error';
    const { chats, store, llmErrors, sent, created, wait } = setup(() => mode);
    const session = chats.create('/w');
    chats.send(session.id, 'Question');
    await wait(session.id);
    expect(llmErrors).toEqual(['llm/unreachable']);
    mode = 'ok';
    chats.retry(session.id);
    await wait(session.id);
    expect(sent[1]).toMatchObject({ input: 'Question', history: [] });
    expect(created).toHaveLength(2);
    expect(store.messages(session.id).filter((m) => m.role === 'user')).toHaveLength(1);
    expect(() => chats.retry(session.id)).toThrow(/Aucun tour/);
  });

  it('transforme une erreur de création en event error, relançable', async () => {
    const { chats, events, wait } = setup(() => 'ok', true);
    const session = chats.create('/w');
    chats.send(session.id, 'x');
    await wait(session.id);
    expect(events).toMatchObject([
      { type: 'error', error: { code: 'internal', message: 'pas de serveur' } },
    ]);
    expect(() => chats.retry(session.id)).not.toThrow();
  });
});
