import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, SessionSummary } from '@atelier/shared';
import { InMemorySessionStore, type SessionStore } from './session-store.js';
import { migrate, openDatabase, SCHEMA_VERSION, SqliteSessionStore } from './sqlite-store.js';

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
