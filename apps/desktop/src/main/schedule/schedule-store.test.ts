import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  openDatabase,
  SCHEMA_VERSION,
  SqliteSessionStore,
} from '../runtime/sqlite-store.js';
import { SqliteUsageStore, usageRecord } from '../runtime/usage-store.js';
import {
  InMemoryScheduleStore,
  SqliteScheduleStore,
  type ScheduleStore,
  type StoredRun,
  type StoredTask,
} from './schedule-store.js';

const NOW = new Date(2026, 9, 31, 12, 0, 0);

const task = (id: string, overrides: Partial<StoredTask> = {}): StoredTask => ({
  id,
  name: `Tâche ${id}`,
  prompt: 'Fais le rapport',
  workspace: '/w',
  schedule: { kind: 'daily', time: '08:00' },
  permissions: { fileWrite: true, commands: false, webDomains: [], mcpTools: [] },
  maxDurationMinutes: 20,
  enabled: true,
  nextRunAt: '2026-11-01T07:00:00.000Z',
  createdAt: `2026-10-0${id === 't1' ? '1' : '2'}T08:00:00.000Z`,
  updatedAt: '2026-10-02T08:00:00.000Z',
  ...overrides,
});

const run = (id: string, overrides: Partial<StoredRun> = {}): StoredRun => ({
  id,
  taskId: 't1',
  trigger: 'schedule',
  status: 'success',
  scheduledFor: new Date(2026, 9, 31, 8, 0).toISOString(),
  startedAt: new Date(2026, 9, 31, 8, 0).toISOString(),
  finishedAt: new Date(2026, 9, 31, 8, 2).toISOString(),
  files: [],
  denied: [],
  ...overrides,
});

/** Jeu commun : deux tâches, des runs sur trois jours et un vieux run. */
function fill(store: ScheduleStore): void {
  store.saveTask(task('t1'));
  store.saveTask(task('t2', { enabled: false, nextRunAt: undefined }));
  store.createRun(run('r1', { files: ['rapport.xlsx'], summary: 'Rapport prêt.' }));
  store.createRun(
    run('r2', {
      status: 'error',
      scheduledFor: new Date(2026, 9, 30, 8, 0).toISOString(),
      startedAt: new Date(2026, 9, 30, 8, 0).toISOString(),
      finishedAt: new Date(2026, 9, 30, 8, 4).toISOString(),
      denied: [
        { toolName: 'bash', kind: 'command', scopeKey: 'bash', title: 'Lancer ls' },
        { toolName: 'bash', kind: 'command', scopeKey: 'bash', title: 'Lancer pwd' },
      ],
    }),
  );
  store.createRun(
    run('r3', {
      taskId: 't2',
      status: 'skipped',
      skipReason: 'overlap',
      scheduledFor: new Date(2026, 9, 30, 9, 0).toISOString(),
      startedAt: undefined,
      finishedAt: undefined,
    }),
  );
  store.createRun(run('vieux', { scheduledFor: new Date(2026, 6, 1, 8, 0).toISOString() }));
}

async function sqlite(): Promise<{ store: SqliteScheduleStore; sessions: SqliteSessionStore }> {
  const db = await openDatabase(':memory:');
  return { store: new SqliteScheduleStore(db), sessions: new SqliteSessionStore(db) };
}

describe.each([
  ['SQLite', async (): Promise<ScheduleStore> => (await sqlite()).store],
  ['mémoire', (): Promise<ScheduleStore> => Promise.resolve(new InMemoryScheduleStore())],
])('ScheduleStore (%s)', (_name, make) => {
  it('enregistre et relit les tâches, avec leur dernier run', async () => {
    const store = await make();
    fill(store);
    const tasks = store.listTasks();
    expect(tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(tasks[0]).toMatchObject({
      schedule: { kind: 'daily', time: '08:00' },
      enabled: true,
      lastRun: { id: 'r1', status: 'success' },
    });
    expect(tasks[1]?.nextRunAt).toBeUndefined();
    store.saveTask(task('t1', { name: 'Renommée' }));
    expect(store.getTask('t1')?.name).toBe('Renommée');
  });

  it('runs : plus récent d’abord, nom de la tâche, durée, pagination et filtre', async () => {
    const store = await make();
    fill(store);
    const runs = store.runs();
    expect(runs.map((r) => r.id)).toEqual(['r1', 'r3', 'r2', 'vieux']);
    expect(runs[0]).toMatchObject({
      taskName: 'Tâche t1',
      durationMs: 120_000,
      files: ['rapport.xlsx'],
    });
    expect(store.runs({ taskId: 't2' }).map((r) => r.id)).toEqual(['r3']);
    expect(store.runs({ before: runs[1]?.scheduledFor, limit: 1 }).map((r) => r.id)).toEqual([
      'r2',
    ]);
  });

  it('runs ouverts, mise à jour et « interrupted » au redémarrage', async () => {
    const store = await make();
    store.saveTask(task('t1'));
    store.createRun(run('q', { status: 'queued', startedAt: undefined, finishedAt: undefined }));
    store.createRun(run('r', { status: 'running', finishedAt: undefined }));
    expect(
      store
        .openRuns()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['q', 'r']);
    expect(store.updateRun('r', { summary: 'En cours' }).summary).toBe('En cours');
    const interrupted = store.interruptOpenRuns(NOW);
    expect(interrupted.map((r) => r.status)).toEqual(['interrupted', 'interrupted']);
    expect(store.openRuns()).toEqual([]);
  });

  it('agrégats du tableau de bord sur la période', async () => {
    const store = await make();
    fill(store);
    const dashboard = store.dashboard('7d', NOW);
    expect(dashboard).toMatchObject({
      period: '7d',
      activeTasks: 1,
      nextRunAt: '2026-11-01T07:00:00.000Z',
      runs: 3,
      // Le run sauté n'entre pas dans le taux : 1 réussi sur 2.
      successRate: 0.5,
      avgDurationMs: 180_000,
      deniedActions: 2,
      skippedRuns: 1,
      daily: [
        { day: '2026-10-30', success: 0, error: 1, skipped: 1 },
        { day: '2026-10-31', success: 1, error: 0, skipped: 0 },
      ],
    });
    expect(dashboard.tasks.map((t) => [t.id, t.periodRuns, t.periodSuccessRate])).toEqual([
      ['t1', 2, 0.5],
      ['t2', 1, undefined],
    ]);
    expect(store.dashboard('all', NOW).runs).toBe(4);
  });

  it('tableau de bord vide', async () => {
    const store = await make();
    expect(store.dashboard('30d', NOW)).toEqual({
      period: '30d',
      activeTasks: 0,
      runs: 0,
      totalTokens: 0,
      deniedActions: 0,
      skippedRuns: 0,
      daily: [],
      tasks: [],
    });
  });

  it('suppression d’une tâche : ses runs disparaissent', async () => {
    const store = await make();
    fill(store);
    store.deleteTask('t1');
    expect(store.runs().map((r) => r.taskId)).toEqual(['t2']);
  });
});

describe('SqliteScheduleStore', () => {
  it('tokens du run par jointure avec usage_turns', async () => {
    const db = await openDatabase(':memory:');
    const store = new SqliteScheduleStore(db);
    store.saveTask(task('t1'));
    store.createRun(run('r1', { turnId: 'turn1' }));
    new SqliteUsageStore(db).record(
      usageRecord({
        turnId: 'turn1',
        sessionId: 'x',
        model: 'm',
        outcome: 'stop',
        compactions: 0,
        at: NOW,
        usage: { inputTokens: 900, outputTokens: 100, totalInputTokens: 1500 },
      }),
    );
    expect(store.getRun('r1')?.totalTokens).toBe(1600);
    expect(store.dashboard('7d', NOW).totalTokens).toBe(1600);
  });

  it('purge à 90 jours : la conversation d’un run est supprimée sauf si l’utilisateur y a écrit', async () => {
    const { store, sessions } = await sqlite();
    store.saveTask(task('t1'));
    for (const id of ['s-lu', 's-repris']) {
      sessions.create({
        id,
        title: id,
        workspace: '/w',
        createdAt: 'a',
        updatedAt: 'a',
        scheduledTaskId: 't1',
      });
    }
    const old = new Date(2026, 6, 1, 8, 0).toISOString();
    store.createRun(run('r-lu', { scheduledFor: old, sessionId: 's-lu' }));
    store.createRun(run('r-repris', { scheduledFor: old, sessionId: 's-repris' }));
    store.createRun(run('r-recent'));
    for (const [i, role] of (['user', 'assistant', 'user'] as const).entries()) {
      sessions.saveMessage({
        id: `m${String(i)}`,
        sessionId: 's-repris',
        role,
        parts: [{ type: 'text', text: 'x' }],
        createdAt: 'a',
      });
    }
    expect(store.purge(new Date(2026, 7, 2))).toBe(2);
    expect(store.runs().map((r) => r.id)).toEqual(['r-recent']);
    expect(sessions.get('s-lu')).toBeUndefined();
    expect(sessions.get('s-repris')).toBeDefined();
  });

  it('migre une base v3 vers v4 ; les conversations de runs sont exclues de la liste par défaut', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'atelier-sched-')), 'atelier.db');
    const { DatabaseSync } = await import('node:sqlite');
    const v3 = new DatabaseSync(file);
    for (const sql of MIGRATIONS.slice(0, 3)) v3.exec(sql);
    v3.exec(`INSERT INTO sessions (id, title, workspace, created_at, updated_at)
               VALUES ('s1', 'Ancienne', '/w', 'a', 'b');
             PRAGMA user_version = 3;`);
    v3.close();

    const db = await openDatabase(file);
    expect(SCHEMA_VERSION).toBe(4);
    const sessions = new SqliteSessionStore(db);
    expect(sessions.get('s1')).toEqual({
      id: 's1',
      title: 'Ancienne',
      workspace: '/w',
      createdAt: 'a',
      updatedAt: 'b',
    });
    sessions.create({
      id: 's2',
      title: 'Run',
      workspace: '/w',
      createdAt: 'c',
      updatedAt: 'c',
      scheduledTaskId: 't1',
    });
    expect(sessions.list().map((s) => s.id)).toEqual(['s1']);
    expect(sessions.list(50, { includeScheduled: true }).map((s) => s.id)).toEqual(['s2', 's1']);
    expect(sessions.get('s2')).toMatchObject({ scheduledTaskId: 't1' });
    new SqliteScheduleStore(db).saveTask(task('t1'));
    db.close();
  });
});
