import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunTurnOptions, TurnResult } from '@atelier/agent-core';
import { InMemoryToolRegistry, type AgentEvent, type PermissionRequest } from '@atelier/shared';
import { importAttachments, safeFileName } from './attachments.js';
import { ChatManager, type TurnRunner } from './chat-manager.js';
import { PermissionBroker } from './permission-broker.js';
import { InMemorySessionStore } from './session-store.js';

const request = (id: string, sessionId = 's1', scopeKey = 'write_file'): PermissionRequest => ({
  id,
  sessionId,
  toolCallId: 'c',
  toolName: 'write_file',
  kind: 'file_write',
  title: 'Écrire a.md',
  scopeKey,
  input: {},
});

describe('PermissionBroker', () => {
  it('attend la réponse de la modale et mémorise « toujours pour la session »', async () => {
    const broker = new PermissionBroker();
    const handler = broker.handlerFor('s1');
    const first = handler(request('r1'));
    expect(broker.pending().map((r) => r.id)).toEqual(['r1']);
    broker.respond('r1', 'allow_session');
    expect(await first).toBe('allow_session');
    // Même portée : plus de modale.
    expect(await handler(request('r2'))).toBe('allow_session');
    expect(broker.pending()).toEqual([]);
  });

  it('refuse sur annulation et via denyAll', async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const pending = broker.handlerFor('s1')(request('r1'), controller.signal);
    controller.abort();
    expect(await pending).toBe('deny');
    const other = broker.handlerFor('s2')(request('r2', 's2'));
    broker.denyAll('s2');
    expect(await other).toBe('deny');
    expect(broker.respond('inconnu', 'allow_once')).toBe(false);
  });
});

/** Agent factice : émet un texte, ou attend l'annulation, ou échoue. */
function fakeRunner(mode: 'ok' | 'error' | 'hang', seen: RunTurnOptions[] = []): TurnRunner {
  return {
    runTurn: async (o): Promise<TurnResult> => {
      seen.push(o);
      const ev = { sessionId: o.sessionId, turnId: o.turnId };
      if (mode === 'hang') {
        o.emit({ ...ev, type: 'tool_start', toolCallId: 'c1', toolName: 'bash', input: {} });
        await new Promise<void>((resolve) =>
          o.abortSignal?.addEventListener('abort', () => {
            resolve();
          }),
        );
        o.emit({ ...ev, type: 'done', reason: 'aborted' });
        return { messages: [...o.history], reason: 'aborted' };
      }
      if (mode === 'error') {
        const error = { code: 'llm/unreachable' as const, message: 'down', retryable: true };
        o.emit({ ...ev, type: 'error', error });
        return { messages: [...o.history], reason: 'error', error };
      }
      o.emit({ ...ev, type: 'text_delta', delta: 'Bonjour !' });
      o.emit({ ...ev, type: 'done', reason: 'stop' });
      return {
        messages: [
          ...o.history,
          { role: 'user', content: typeof o.input === 'string' ? o.input : '' },
          { role: 'assistant', content: 'Bonjour !' },
        ],
        reason: 'stop',
        usage: { inputTokens: 100, outputTokens: 5 },
      };
    },
  };
}

function setup(mode: () => 'ok' | 'error' | 'hang') {
  const events: AgentEvent[] = [];
  const llmErrors: string[] = [];
  const seen: RunTurnOptions[] = [];
  const store = new InMemorySessionStore();
  let n = 0;
  const chats = new ChatManager({
    store,
    permissions: new PermissionBroker(),
    createRegistry: () => new InMemoryToolRegistry(),
    createRunner: () => Promise.resolve(fakeRunner(mode(), seen)),
    emit: (e) => events.push(e),
    onLlmError: (e) => llmErrors.push(e.code),
    newId: () => `id${String((n += 1))}`,
    now: () => new Date('2026-10-28T10:00:00.000Z'),
  });
  const wait = async (sessionId: string): Promise<void> => {
    while (chats.isRunning(sessionId)) await new Promise((r) => setTimeout(r, 1));
  };
  return { chats, store, events, llmErrors, seen, wait };
}

describe('ChatManager', () => {
  it('exécute un tour, relaie les events et persiste les messages', async () => {
    const { chats, events, seen, wait } = setup(() => 'ok');
    const session = chats.create('/w');
    const { turnId } = chats.send(session.id, 'Salut, aide-moi');
    await wait(session.id);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done']);
    expect(events[0]?.turnId).toBe(turnId);
    const { session: opened, messages } = chats.open(session.id);
    expect(opened.title).toBe('Salut, aide-moi');
    expect(messages.map((m) => [m.role, m.parts[0]])).toEqual([
      ['user', { type: 'text', text: 'Salut, aide-moi' }],
      ['assistant', { type: 'text', text: 'Bonjour !' }],
    ]);
    // Le tour suivant reçoit l'historique et les tokens du précédent.
    chats.send(session.id, 'Et ensuite ?');
    await wait(session.id);
    expect(seen[1]?.history).toHaveLength(2);
    expect(seen[1]?.lastInputTokens).toBe(100);
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

  it('relance un tour en erreur avec la même demande', async () => {
    let mode: 'ok' | 'error' = 'error';
    const { chats, store, llmErrors, seen, wait } = setup(() => mode);
    const session = chats.create('/w');
    chats.send(session.id, 'Question');
    await wait(session.id);
    expect(llmErrors).toEqual(['llm/unreachable']);
    mode = 'ok';
    chats.retry(session.id);
    await wait(session.id);
    expect(seen[1]?.input).toBe('Question');
    // Pas de second message utilisateur.
    expect(store.messages(session.id).filter((m) => m.role === 'user')).toHaveLength(1);
    expect(() => chats.retry(session.id)).toThrow(/Aucun tour/);
  });

  it('transforme une erreur de fabrique en event error', async () => {
    const events: AgentEvent[] = [];
    const chats = new ChatManager({
      store: new InMemorySessionStore(),
      permissions: new PermissionBroker(),
      createRegistry: () => new InMemoryToolRegistry(),
      createRunner: () => Promise.reject(new Error('pas de serveur')),
      emit: (e) => events.push(e),
    });
    const session = chats.create('/w');
    chats.send(session.id, 'x');
    while (chats.isRunning(session.id)) await new Promise((r) => setTimeout(r, 1));
    expect(events).toMatchObject([
      { type: 'error', error: { code: 'internal', message: 'pas de serveur' } },
    ]);
  });
});

describe('pièces jointes', () => {
  it('copie dans .atelier/uploads sans écraser', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'atelier-ws-'));
    const source = join(await mkdtemp(join(tmpdir(), 'atelier-src-')), 'facture.pdf');
    await writeFile(source, 'pdf');
    const [first] = await importAttachments(workspace, [source]);
    const [second] = await importAttachments(workspace, [source]);
    expect(first).toEqual({
      path: '.atelier/uploads/facture.pdf',
      name: 'facture.pdf',
      size: 3,
      mimeType: 'application/pdf',
    });
    expect(second?.path).toBe('.atelier/uploads/facture (2).pdf');
    expect(await readFile(join(workspace, '.atelier/uploads/facture (2).pdf'), 'utf8')).toBe('pdf');
  });

  it('nettoie les noms de fichiers', () => {
    expect(safeFileName('..secret')).toBe('secret');
    expect(safeFileName('a:b.txt')).toBe('a_b.txt');
    expect(safeFileName('.')).toBe('fichier');
  });

  it('refuse un dossier', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'atelier-ws-'));
    await expect(importAttachments(workspace, [tmpdir()])).rejects.toMatchObject({
      code: 'documents/unsupported_type',
    });
  });
});
