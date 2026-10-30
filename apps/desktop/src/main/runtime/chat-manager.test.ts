import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnResult } from '@atelier/agent-core';
import { AtelierError, type AgentEvent, type AgentEventSink } from '@atelier/shared';
import type { ModelMessage } from 'ai';
import {
  ChatManager,
  type AgentSessionFactory,
  type AgentSessionLike,
  type ChangeTracker,
  type ModelValidator,
  type NewAgentSession,
} from './chat-manager.js';
import { PermissionBroker } from './permission-broker.js';
import { InMemorySessionStore, type SessionStore } from './session-store.js';
import { SqliteSessionStore } from './sqlite-store.js';
import { InMemoryUsageStore, type UsageStore } from './usage-store.js';

type Mode = 'ok' | 'error' | 'hang' | 'tool' | 'compact' | 'usage';

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
      return { messages: withUser, reason: 'aborted', usage: { inputTokens: 40, outputTokens: 3 } };
    }
    if (mode === 'error') {
      const error = { code: 'llm/unreachable' as const, message: 'down', retryable: true };
      emit({ ...ev, type: 'error', error });
      this.history = withUser;
      // L'usage reste présent en erreur (sans event `done`).
      return {
        messages: withUser,
        reason: 'error',
        error,
        usage: { inputTokens: 50, outputTokens: 0, contextWindow: 32_768 },
      };
    }
    if (mode === 'usage') {
      emit({
        ...ev,
        type: 'usage',
        usage: { inputTokens: 100, outputTokens: 2, contextTokens: 102, contextWindow: 32_768 },
      });
    }
    if (mode === 'compact') {
      emit({ ...ev, type: 'compaction', replacedMessages: 4 });
      emit({ ...ev, type: 'compaction', replacedMessages: 2 });
    }
    if (mode === 'tool') {
      emit({ ...ev, type: 'tool_start', toolCallId: 'c1', toolName: 'bash', input: {} });
      emit({
        ...ev,
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 'bash',
        ok: true,
        output: 'ok',
        display: { type: 'command', command: 'python xlsx.py', exitCode: 0, output: '' },
      });
    }
    emit({ ...ev, type: 'text_delta', delta: 'Bonjour !' });
    emit({ ...ev, type: 'done', reason: 'stop' });
    this.history = [...withUser, { role: 'assistant', content: 'Bonjour !' }];
    this.lastInputTokens = 100;
    return {
      messages: [...this.history],
      reason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        contextWindow: 32_768,
        totalInputTokens: 180,
        contextTokens: 105,
        steps: 2,
        generationMs: 250,
      },
    };
  }
}

/** Serveur factice : `9b`, `35b` et `atelier:latest` utilisables, `embed` sans outils, le reste absent. */
class FakeModels implements ModelValidator {
  readonly checked: string[] = [];
  assertUsable(model: string): Promise<void> {
    this.checked.push(model);
    if (model === 'nomic-embed-text') {
      return Promise.reject(
        new AtelierError('llm/model_unsupported', 'sans outils', { details: { missing: 'tools' } }),
      );
    }
    if (!['qwen3.5:9b', 'qwen3.5:35b', 'atelier:latest'].includes(model)) {
      return Promise.reject(new AtelierError('llm/model_not_found', 'absent'));
    }
    return Promise.resolve();
  }
}

function setup(
  mode: () => Mode,
  failCreate = false,
  store: SessionStore = new InMemorySessionStore(),
  trackChanges?: (workspace: string) => ChangeTracker,
  usage: UsageStore = new InMemoryUsageStore(),
) {
  let defaultModel = 'qwen3.5:35b';
  const models = new FakeModels();
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
  let n = 0;
  const chats = new ChatManager({
    store,
    permissions: new PermissionBroker(),
    agents,
    emit: (e) => events.push(e),
    onLlmError: (e) => llmErrors.push(e.code),
    newId: () => `id${String((n += 1))}`,
    now: () => new Date('2026-10-28T10:00:00.000Z'),
    ...(trackChanges ? { trackChanges } : {}),
    usage,
    defaultModel: () => defaultModel,
    models,
  });
  const wait = async (sessionId: string): Promise<void> => {
    while (chats.isRunning(sessionId)) await new Promise((r) => setTimeout(r, 1));
  };
  const bump = (): void => {
    generation += 1;
  };
  /** Change le modèle par défaut des Réglages. */
  const setDefault = (next: string): void => {
    defaultModel = next;
  };
  return {
    chats,
    store,
    events,
    llmErrors,
    sent,
    created,
    prepared,
    wait,
    bump,
    usage,
    setDefault,
    models,
  };
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

  it('joint les fichiers produits par un outil (bash dans la VM) avant la fin du tour', async () => {
    const calls: string[] = [];
    const xlsx = {
      path: 'recap.xlsx',
      absolutePath: '/w/recap.xlsx',
      size: 9,
      action: 'created' as const,
    };
    const tracker = (workspace: string): ChangeTracker => ({
      start: () => {
        calls.push(`start@${workspace}`);
        return Promise.resolve();
      },
      afterTool: async (display) => {
        calls.push(`after:${display?.type ?? 'none'}`);
        // Photo lente : l'ordre des événements doit rester celui de l'agent.
        await new Promise((r) => setTimeout(r, 5));
        return [xlsx];
      },
    });
    const { chats, events, wait } = setup(() => 'tool', false, undefined, tracker);
    const session = chats.create('/w');
    chats.send(session.id, 'Fais le classeur');
    await wait(session.id);
    expect(calls).toEqual(['start@/w', 'after:command']);
    expect(events.map((e) => e.type)).toEqual([
      'tool_start',
      'tool_result',
      'tool_files',
      'text_delta',
      'done',
    ]);
    const [, assistant] = chats.open(session.id).messages;
    expect(assistant?.parts[0]).toMatchObject({ type: 'tool_call', files: [xlsx] });
  });

  it('un suivi des fichiers en échec ne casse pas le tour', async () => {
    const tracker = (): ChangeTracker => ({
      start: () => Promise.reject(new Error('illisible')),
      afterTool: () => Promise.reject(new Error('illisible')),
    });
    const { chats, events, wait } = setup(() => 'tool', false, undefined, tracker);
    const session = chats.create('/w');
    chats.send(session.id, 'Fais le classeur');
    await wait(session.id);
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_result', 'text_delta', 'done']);
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

  it('reprend une conversation après redémarrage avec l’historique modèle persisté', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'atelier-resume-')), 'atelier.db');
    const before = setup(() => 'ok', false, await SqliteSessionStore.open(file));
    const session = before.chats.create('/w');
    before.chats.send(session.id, 'Première question');
    await before.wait(session.id);
    before.store.close?.();

    // « Redémarrage » : nouveau gestionnaire, même fichier.
    const after = setup(() => 'ok', false, await SqliteSessionStore.open(file));
    expect(after.chats.list().map((s) => s.title)).toEqual(['Première question']);
    expect(after.chats.open(session.id).messages).toHaveLength(2);
    after.chats.send(session.id, 'Suite');
    await after.wait(session.id);
    expect(after.created[0]?.history).toEqual([
      { role: 'user', content: 'Première question' },
      { role: 'assistant', content: 'Bonjour !' },
    ]);
    after.store.close?.();
  });

  it('enregistre un tour par modèle avec l’usage du TurnResult et le relaie à la réouverture', async () => {
    const usage = new InMemoryUsageStore();
    const { chats, wait, setDefault } = setup(() => 'ok', false, undefined, undefined, usage);
    const session = chats.create('/w');
    const { turnId } = chats.send(session.id, 'Un');
    await wait(session.id);
    // Le défaut des Réglages ne touche pas une conversation qui a son modèle.
    setDefault('qwen3.5:122b');
    await chats.setModel(session.id, 'qwen3.5:9b');
    chats.send(session.id, 'Deux');
    await wait(session.id);
    expect(usage.all()).toMatchObject([
      {
        turnId,
        sessionId: session.id,
        model: 'qwen3.5:35b',
        outcome: 'stop',
        day: '2026-10-28',
        steps: 2,
        inputTokens: 180,
        outputTokens: 5,
        contextTokens: 105,
        contextWindow: 32_768,
        generationMs: 250,
        compactions: 0,
      },
      { model: 'qwen3.5:9b' },
    ]);
    expect(chats.open(session.id).usage).toMatchObject({
      contextTokens: 105,
      contextWindow: 32_768,
    });
  });

  it('enregistre aussi un tour en erreur et un tour annulé', async () => {
    let mode: Mode = 'error';
    const usage = new InMemoryUsageStore();
    const { chats, wait } = setup(() => mode, false, undefined, undefined, usage);
    const session = chats.create('/w');
    chats.send(session.id, 'Question');
    await wait(session.id);
    mode = 'hang';
    chats.retry(session.id);
    await new Promise((r) => setTimeout(r, 5));
    await chats.stop(session.id);
    await wait(session.id);
    expect(usage.all().map((r) => [r.outcome, r.inputTokens])).toEqual([
      ['error', 50],
      ['aborted', 40],
    ]);
  });

  it('compte les compactions vues pendant le tour', async () => {
    const usage = new InMemoryUsageStore();
    const { chats, events, wait } = setup(() => 'compact', false, undefined, undefined, usage);
    const session = chats.create('/w');
    chats.send(session.id, 'Long');
    await wait(session.id);
    expect(events.filter((e) => e.type === 'compaction')).toHaveLength(2);
    expect(usage.all()[0]?.compactions).toBe(2);
  });

  it('relaie les events `usage` sans toucher au message persisté', async () => {
    const { chats, store, events, wait } = setup(() => 'usage');
    const session = chats.create('/w');
    chats.send(session.id, 'Salut');
    await wait(session.id);
    expect(events.map((e) => e.type)).toEqual(['usage', 'text_delta', 'done']);
    expect(store.messages(session.id).at(-1)?.parts).toEqual([{ type: 'text', text: 'Bonjour !' }]);
  });

  it('un registre en panne ne casse ni le tour ni la réouverture', async () => {
    const broken: UsageStore = {
      record: () => {
        throw new Error('disque plein');
      },
      summary: () => {
        throw new Error('disque plein');
      },
      lastForSession: () => {
        throw new Error('disque plein');
      },
      detachSession: () => {
        throw new Error('disque plein');
      },
    };
    const { chats, events, wait } = setup(() => 'ok', false, undefined, undefined, broken);
    const session = chats.create('/w');
    chats.send(session.id, 'Salut');
    await wait(session.id);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done']);
    expect(chats.open(session.id).usage).toBeUndefined();
    await expect(chats.delete(session.id)).resolves.toBeUndefined();
  });
});

describe('ChatManager : modèle par conversation (#13)', () => {
  it('« atelier » et « atelier:latest » sont le même modèle : ni vérification, ni recréation, une ligne d’usage', async () => {
    const usage = new InMemoryUsageStore();
    const { chats, store, created, models, wait, setDefault } = setup(
      () => 'ok',
      false,
      undefined,
      undefined,
      usage,
    );
    setDefault('atelier');
    const session = chats.create('/w');
    // Le sélecteur propose le nom du serveur : même modèle, rien à vérifier ni à enregistrer.
    expect((await chats.setModel(session.id, 'atelier:latest')).model).toBe('atelier');
    expect(models.checked).toEqual([]);

    // Conversation antérieure qui suit le défaut « atelier », puis choisit « atelier:latest ».
    const legacy = store.create({
      id: 'ancienne',
      title: 'Ancienne',
      workspace: '/w',
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    });
    chats.send(legacy.id, 'Un');
    await wait(legacy.id);
    await chats.setModel(legacy.id, 'atelier:latest');
    chats.send(legacy.id, 'Deux');
    await wait(legacy.id);
    expect(created).toHaveLength(1);
    expect(usage.all().map((r) => r.model)).toEqual(['atelier', 'atelier']);
  });

  it('copie le modèle par défaut à la création : le changer ensuite ne touche pas la conversation', async () => {
    const { chats, created, store, wait, setDefault } = setup(() => 'ok');
    const session = chats.create('/w');
    expect(session.model).toBe('qwen3.5:35b');
    setDefault('qwen3.5:9b');
    chats.send(session.id, 'Salut');
    await wait(session.id);
    expect(created.map((c) => c.model)).toEqual(['qwen3.5:35b']);
    expect(store.messages(session.id).at(-1)?.model).toBe('qwen3.5:35b');
  });

  it('une conversation sans modèle (antérieure à #13) suit le défaut, même quand il change', async () => {
    const { chats, store, created, wait, setDefault } = setup(() => 'ok');
    const legacy = store.create({
      id: 'ancienne',
      title: 'Ancienne',
      workspace: '/w',
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    });
    chats.send(legacy.id, 'Un');
    await wait(legacy.id);
    setDefault('qwen3.5:9b');
    chats.send(legacy.id, 'Deux');
    await wait(legacy.id);
    expect(created.map((c) => c.model)).toEqual(['qwen3.5:35b', 'qwen3.5:9b']);
    expect(chats.open(legacy.id).session.model).toBeUndefined();
  });

  it('recrée la session agent quand le modèle change, avec l’historique et la consommation du dernier tour', async () => {
    const { chats, created, sent, store, wait } = setup(() => 'ok');
    const session = chats.create('/w');
    chats.send(session.id, 'Un');
    await wait(session.id);
    expect((await chats.setModel(session.id, 'qwen3.5:9b')).model).toBe('qwen3.5:9b');
    chats.send(session.id, 'Deux');
    await wait(session.id);
    expect(created).toHaveLength(2);
    // `lastInputTokens` suit : la compaction passe avant l'appel si la fenêtre est plus petite.
    expect(created[1]).toMatchObject({ model: 'qwen3.5:9b', lastInputTokens: 100 });
    expect(created[1]?.history).toHaveLength(2);
    expect(sent[1]?.history).toHaveLength(2);
    // Chaque réponse garde le modèle qui l'a produite (séparateur dans le fil).
    expect(
      store
        .messages(session.id)
        .filter((m) => m.role === 'assistant')
        .map((m) => m.model),
    ).toEqual(['qwen3.5:35b', 'qwen3.5:9b']);
  });

  it('set-model : refusé pendant un tour, modèle absent ou sans outils refusé, null revient au défaut', async () => {
    let mode: Mode = 'hang';
    const { chats, models, wait } = setup(() => mode);
    const session = chats.create('/w');
    chats.send(session.id, 'Long');
    await expect(chats.setModel(session.id, 'qwen3.5:9b')).rejects.toMatchObject({
      code: 'agent/busy',
    });
    await new Promise((r) => setTimeout(r, 5));
    await chats.stop(session.id);
    await wait(session.id);
    mode = 'ok';

    await expect(chats.setModel(session.id, 'mistral:7b')).rejects.toMatchObject({
      code: 'llm/model_not_found',
    });
    await expect(chats.setModel(session.id, 'nomic-embed-text')).rejects.toMatchObject({
      code: 'llm/model_unsupported',
      details: { missing: 'tools' },
    });
    await expect(chats.setModel(session.id, '  ')).rejects.toMatchObject({
      code: 'tool/invalid_input',
    });
    expect(chats.open(session.id).session.model).toBe('qwen3.5:35b');

    // Même modèle : rien à vérifier auprès du serveur.
    const checked = models.checked.length;
    await chats.setModel(session.id, 'qwen3.5:35b');
    expect(models.checked).toHaveLength(checked);

    const reset = await chats.setModel(session.id, null);
    expect(reset).not.toHaveProperty('model');
    expect(chats.open(session.id).session).not.toHaveProperty('model');
    await expect(chats.setModel('inconnue', null)).rejects.toMatchObject({
      code: 'session/not_found',
    });
  });
});
