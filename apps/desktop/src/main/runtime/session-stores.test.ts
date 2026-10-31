import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, SessionSummary } from '@atelier/shared';
import { InMemorySessionStore, type SessionStore } from './session-store.js';
import {
  migrate,
  MIGRATIONS,
  openDatabase,
  SCHEMA_VERSION,
  SqliteSessionStore,
} from './sqlite-store.js';

const session = (id: string, updatedAt: string): SessionSummary => ({
  id,
  title: `Conversation ${id}`,
  workspace: '/Users/test/Dossier',
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt,
});

const message = (id: string, sessionId: string, text: string): ChatMessage => ({
  id,
  sessionId,
  role: 'user',
  parts: [{ type: 'text', text }],
  createdAt: '2026-10-28T09:00:00.000Z',
});

const stores: [string, () => Promise<SessionStore>][] = [
  ['mémoire', () => Promise.resolve(new InMemorySessionStore())],
  ['SQLite', () => SqliteSessionStore.open(':memory:')],
];

describe.each(stores)('SessionStore (%s)', (_name, make) => {
  it('crée, liste par activité récente, renomme et supprime', async () => {
    const store = await make();
    store.create(session('a', '2026-10-28T09:00:00.000Z'));
    store.create(session('b', '2026-10-28T10:00:00.000Z'));
    expect(store.list().map((s) => s.id)).toEqual(['b', 'a']);
    store.update('a', { title: 'Récap', updatedAt: '2026-10-28T11:00:00.000Z' });
    expect(store.list(1)).toEqual([
      { ...session('a', '2026-10-28T11:00:00.000Z'), title: 'Récap' },
    ]);
    store.delete('a');
    expect(store.get('a')).toBeUndefined();
    expect(() => store.update('a', { title: 'x' })).toThrow(/introuvable/);
  });

  it('ajoute et remplace des messages dans l’ordre, garde l’historique modèle', async () => {
    const store = await make();
    store.create(session('s', '2026-10-28T09:00:00.000Z'));
    store.saveMessage(message('m1', 's', 'Un'));
    store.saveMessage(message('m2', 's', 'Deux'));
    store.saveMessage(message('m1', 's', 'Un, corrigé'));
    expect(store.messages('s').map((m) => m.parts[0])).toEqual([
      { type: 'text', text: 'Un, corrigé' },
      { type: 'text', text: 'Deux' },
    ]);
    expect(store.modelHistory('s')).toBeUndefined();
    store.saveModelHistory('s', [{ role: 'user', content: 'Un' }]);
    store.saveModelHistory('s', [
      { role: 'user', content: 'Un' },
      { role: 'assistant', content: 'Réponse' },
    ]);
    expect(store.modelHistory('s')).toHaveLength(2);
    expect(() => {
      store.saveMessage(message('x', 'inconnue', 'x'));
    }).toThrow(/introuvable/);
    store.delete('s');
    expect(store.messages('s')).toEqual([]);
    expect(store.modelHistory('s')).toBeUndefined();
  });

  it('garde le modèle de la conversation (null : retour au défaut) et celui des réponses', async () => {
    const store = await make();
    store.create({ ...session('s', '2026-10-28T09:00:00.000Z'), model: 'qwen3.5:35b' });
    expect(store.get('s')?.model).toBe('qwen3.5:35b');
    expect(store.update('s', { model: 'qwen3.5:9b' }).model).toBe('qwen3.5:9b');
    // Un patch sans `model` ne l'efface pas.
    expect(store.update('s', { title: 'Récap' })).toMatchObject({
      title: 'Récap',
      model: 'qwen3.5:9b',
    });
    expect(store.update('s', { model: null })).not.toHaveProperty('model');
    expect(store.get('s')).not.toHaveProperty('model');

    store.saveMessage({ ...message('m1', 's', 'Réponse'), role: 'assistant', model: 'qwen3.5:9b' });
    store.saveMessage(message('m2', 's', 'Question'));
    const [answer, question] = store.messages('s');
    expect(answer?.model).toBe('qwen3.5:9b');
    expect(question).not.toHaveProperty('model');
  });
});

describe('SqliteSessionStore', () => {
  it('persiste sur disque et se rouvre (WAL, schéma versionné)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'atelier-db-')), 'atelier.db');
    const first = await SqliteSessionStore.open(file);
    first.create(session('s', '2026-10-28T09:00:00.000Z'));
    first.saveMessage(message('m1', 's', 'Bonjour'));
    first.saveModelHistory('s', [{ role: 'user', content: 'Bonjour' }]);
    first.close();

    const reopened = await SqliteSessionStore.open(file);
    expect(reopened.list().map((s) => s.id)).toEqual(['s']);
    expect(reopened.messages('s')).toHaveLength(1);
    expect(reopened.modelHistory('s')).toEqual([{ role: 'user', content: 'Bonjour' }]);
    reopened.close();

    const db = await openDatabase(file);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    db.close();
  });

  it('migre une base v2 vers v3 : les conversations existantes suivent le modèle par défaut', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'atelier-v2-')), 'atelier.db');
    const { DatabaseSync } = await import('node:sqlite');
    const v2 = new DatabaseSync(file);
    for (const sql of MIGRATIONS.slice(0, 2)) v2.exec(sql);
    v2.exec(`INSERT INTO sessions VALUES ('s1', 'Ancienne', '/w', 'a', 'b');
             INSERT INTO messages VALUES ('m1', 's1', 1, 'assistant', '[{"type":"text","text":"Oui"}]', 'a');
             PRAGMA user_version = 2;`);
    v2.close();

    const store = await SqliteSessionStore.open(file);
    expect(store.get('s1')).toEqual({
      id: 's1',
      title: 'Ancienne',
      workspace: '/w',
      createdAt: 'a',
      updatedAt: 'b',
    });
    expect(store.messages('s1')).toEqual([
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Oui' }],
        createdAt: 'a',
      },
    ]);
    expect(store.update('s1', { model: 'qwen3.5:9b' }).model).toBe('qwen3.5:9b');
    expect(store.get('s1')?.model).toBe('qwen3.5:9b');
    store.close();
    expect(SCHEMA_VERSION).toBe(5);
  });

  it('refuse une base créée par une version plus récente', async () => {
    const db = await openDatabase(':memory:');
    db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
    expect(() => {
      migrate(db);
    }).toThrow(/plus récente/);
  });

  it('masque seulement l’avertissement expérimental de SQLite', async () => {
    await openDatabase(':memory:');
    const listener = vi.fn();
    process.on('warning', listener);
    process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');
    process.emitWarning('Autre avertissement', 'DeprecationWarning');
    await new Promise((resolve) => setImmediate(resolve));
    process.off('warning', listener);
    expect(listener.mock.calls.map(([w]) => (w as Error).name)).toEqual(['DeprecationWarning']);
  });
});
