import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION, SqliteSessionStore } from './sqlite-store.js';
import {
  InMemoryUsageStore,
  SqliteUsageStore,
  summarize,
  usageRecord,
  type UsageRecord,
  type UsageStore,
} from './usage-store.js';

const NOW = new Date(2026, 9, 30, 12, 0, 0);

function record(overrides: Partial<UsageRecord> & Pick<UsageRecord, 'turnId'>): UsageRecord {
  return {
    sessionId: 's1',
    model: 'qwen3.5:35b',
    outcome: 'stop',
    day: '2026-10-30',
    steps: 2,
    inputTokens: 1000,
    outputTokens: 200,
    contextTokens: 8000,
    contextWindow: 32_000,
    generationMs: 4000,
    compactions: 0,
    relaunches: {},
    createdAt: '2026-10-30T10:00:00.000Z',
    ...overrides,
  };
}

/** Jeu de données commun aux deux implémentations. */
const RECORDS: UsageRecord[] = [
  record({ turnId: 't1' }),
  record({
    turnId: 't2',
    outcome: 'error',
    inputTokens: 500,
    outputTokens: 0,
    generationMs: 0,
    contextTokens: 16_000,
    relaunches: { stream_cut: 1 },
    createdAt: '2026-10-30T11:00:00.000Z',
  }),
  record({
    turnId: 't3',
    day: '2026-10-28',
    compactions: 1,
    relaunches: { continuation: 2, empty_final: 1 },
    contextTokens: undefined,
    contextWindow: undefined,
    createdAt: '2026-10-28T09:00:00.000Z',
  }),
  record({
    turnId: 't4',
    model: 'qwen3.5:9b',
    sessionId: 's2',
    inputTokens: 300,
    outputTokens: 100,
    generationMs: 1000,
    contextTokens: 4000,
    contextWindow: 16_000,
  }),
  // Hors période 7 j / 30 j.
  record({
    turnId: 'old',
    day: '2026-08-01',
    inputTokens: 9_000_000,
    createdAt: '2026-08-01T09:00:00.000Z',
  }),
];

async function sqliteStore(): Promise<{ usage: SqliteUsageStore; sessions: SqliteSessionStore }> {
  const db = await openDatabase(':memory:');
  const sessions = new SqliteSessionStore(db);
  for (const id of ['s1', 's2']) {
    sessions.create({ id, title: id, workspace: '/w', createdAt: '', updatedAt: '' });
  }
  return { usage: new SqliteUsageStore(db), sessions };
}

describe.each([
  ['SQLite', async (): Promise<UsageStore> => (await sqliteStore()).usage],
  ['mémoire', (): Promise<UsageStore> => Promise.resolve(new InMemoryUsageStore())],
])('UsageStore (%s)', (_name, make) => {
  it('agrège par modèle (tri par total décroissant) et par jour', async () => {
    const store = await make();
    for (const r of RECORDS) store.record(r);
    const summary = store.summary('30d', NOW);
    expect(summary.period).toBe('30d');
    expect(summary.models.map((m) => m.model)).toEqual(['qwen3.5:35b', 'qwen3.5:9b']);
    const big = summary.models[0];
    expect(big).toMatchObject({
      turns: 3,
      steps: 6,
      inputTokens: 2500,
      outputTokens: 400,
      compactions: 1,
      relaunchedTurns: 2,
      relaunches: { continuation: 2, stream_cut: 1, empty_final: 1 },
      errorTurns: 1,
      lastUsedAt: '2026-10-30T11:00:00.000Z',
    });
    expect(big?.avgTokensPerTurn).toBeCloseTo(2900 / 3);
    // Débit : sortie des tours chronométrés / temps de génération.
    expect(big?.tokensPerSecond).toBeCloseTo((400 / 8000) * 1000);
    // Contexte : tours dont la fenêtre est connue seulement.
    expect(big?.avgContextRatio).toBeCloseTo((0.25 + 0.5) / 2);
    expect(big?.peakContextRatio).toBeCloseTo(0.5);
    expect(summary.daily).toEqual([
      { day: '2026-10-28', model: 'qwen3.5:35b', inputTokens: 1000, outputTokens: 200, turns: 1 },
      { day: '2026-10-30', model: 'qwen3.5:35b', inputTokens: 1500, outputTokens: 200, turns: 2 },
      { day: '2026-10-30', model: 'qwen3.5:9b', inputTokens: 300, outputTokens: 100, turns: 1 },
    ]);
  });

  it('période : 7 j exclut les tours plus anciens, « Tout » les garde', async () => {
    const store = await make();
    for (const r of RECORDS) store.record(r);
    expect(store.summary('7d', NOW).models.reduce((t, m) => t + m.turns, 0)).toBe(4);
    expect(store.summary('all', NOW).models.reduce((t, m) => t + m.turns, 0)).toBe(5);
    // Borne : il y a 6 jours est inclus, il y a 7 jours non.
    store.record(record({ turnId: 'j-6', day: '2026-10-24', model: 'borne' }));
    store.record(record({ turnId: 'j-7', day: '2026-10-23', model: 'borne' }));
    expect(store.summary('7d', NOW).models.find((m) => m.model === 'borne')?.turns).toBe(1);
  });

  it('upsert idempotent : le même tour écrit deux fois compte une fois', async () => {
    const store = await make();
    store.record(record({ turnId: 't1', outputTokens: 10 }));
    store.record(record({ turnId: 't1', outputTokens: 50 }));
    const [model] = store.summary('all', NOW).models;
    expect(model).toMatchObject({ turns: 1, outputTokens: 50 });
  });

  it('période vide et sans temps ni contexte mesurés', async () => {
    const store = await make();
    expect(store.summary('30d', NOW)).toEqual({ period: '30d', models: [], daily: [] });
    store.record(
      record({ turnId: 'x', generationMs: 0, contextTokens: undefined, contextWindow: undefined }),
    );
    const [model] = store.summary('30d', NOW).models;
    expect(model?.tokensPerSecond).toBeUndefined();
    expect(model?.avgContextRatio).toBeUndefined();
    expect(model?.relaunches).toEqual({});
  });

  it('dernier usage d’une conversation (jauge à la réouverture)', async () => {
    const store = await make();
    for (const r of RECORDS) store.record(r);
    expect(store.lastForSession('s1')).toMatchObject({
      contextTokens: 16_000,
      contextWindow: 32_000,
      outputTokens: 0,
      relaunches: { stream_cut: 1 },
    });
    expect(store.lastForSession('inconnue')).toBeUndefined();
  });

  it('un tour plus récent sans contexte (annulé tôt) ne masque pas le dernier contexte connu', async () => {
    const store = await make();
    store.record(
      record({ turnId: 'a', contextTokens: 9000, createdAt: '2026-10-30T10:00:00.000Z' }),
    );
    store.record(
      record({
        turnId: 'b',
        outcome: 'aborted',
        contextTokens: undefined,
        createdAt: '2026-10-30T10:05:00.000Z',
      }),
    );
    expect(store.lastForSession('s1')?.contextTokens).toBe(9000);
  });
});

describe('SqliteUsageStore', () => {
  it('donne les mêmes agrégats que la version en mémoire', async () => {
    const { usage } = await sqliteStore();
    for (const r of RECORDS) usage.record(r);
    for (const period of ['7d', '30d', 'all'] as const) {
      expect(usage.summary(period, NOW)).toEqual(summarize(RECORDS, period, NOW));
    }
  });

  it('garde les tours d’une conversation supprimée, sans lien (ON DELETE SET NULL)', async () => {
    const { usage, sessions } = await sqliteStore();
    usage.record(record({ turnId: 't1' }));
    sessions.delete('s1');
    expect(usage.all()).toMatchObject([{ turnId: 't1', sessionId: undefined }]);
    expect(usage.summary('all', NOW).models[0]?.turns).toBe(1);
    expect(usage.lastForSession('s1')).toBeUndefined();
  });

  it('enregistre sans lien un tour dont la conversation n’existe plus', async () => {
    const { usage } = await sqliteStore();
    usage.record(record({ turnId: 't1', sessionId: 'disparue' }));
    expect(usage.all()[0]?.sessionId).toBeUndefined();
  });

  it('migre une base v1 existante vers v2 sans perdre l’historique', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'atelier-usage-')), 'atelier.db');
    const { DatabaseSync } = await import('node:sqlite');
    const v1 = new DatabaseSync(file);
    v1.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL,
               workspace TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL
               REFERENCES sessions (id) ON DELETE CASCADE, seq INTEGER NOT NULL,
               role TEXT NOT NULL, parts TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE model_history (session_id TEXT PRIMARY KEY
               REFERENCES sessions (id) ON DELETE CASCADE, messages TEXT NOT NULL);
             INSERT INTO sessions VALUES ('s1', 'Ancienne', '/w', 'a', 'b');
             PRAGMA user_version = 1;`);
    v1.close();

    const db = await openDatabase(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    expect(SCHEMA_VERSION).toBe(4);
    expect(new SqliteSessionStore(db).get('s1')?.title).toBe('Ancienne');
    const usage = new SqliteUsageStore(db);
    usage.record(record({ turnId: 't1' }));
    expect(usage.lastForSession('s1')).toBeDefined();
    db.close();
  });
});

describe('usageRecord', () => {
  it('reprend les champs enrichis de L1', () => {
    const at = new Date(2026, 9, 30, 23, 30);
    expect(
      usageRecord({
        turnId: 't',
        sessionId: 's',
        model: 'm',
        outcome: 'max_steps',
        compactions: 2,
        at,
        usage: {
          inputTokens: 900,
          outputTokens: 80,
          contextWindow: 32_768,
          totalInputTokens: 2500,
          contextTokens: 980,
          steps: 3,
          generationMs: 1500,
          relaunches: { continuation: 1, verification: 0 },
        },
      }),
    ).toEqual({
      turnId: 't',
      sessionId: 's',
      model: 'm',
      outcome: 'max_steps',
      day: '2026-10-30',
      steps: 3,
      inputTokens: 2500,
      outputTokens: 80,
      contextTokens: 980,
      contextWindow: 32_768,
      generationMs: 1500,
      compactions: 2,
      relaunches: { continuation: 1 },
      createdAt: at.toISOString(),
    });
  });

  it('avant L1 : entrée de la dernière étape, une étape, pas de durée ni de contexte', () => {
    expect(
      usageRecord({
        turnId: 't',
        sessionId: 's',
        model: 'm',
        outcome: 'stop',
        compactions: 0,
        at: NOW,
        usage: { inputTokens: 900, outputTokens: 80 },
      }),
    ).toMatchObject({
      steps: 1,
      inputTokens: 900,
      generationMs: 0,
      contextTokens: undefined,
      contextWindow: undefined,
    });
  });
});
