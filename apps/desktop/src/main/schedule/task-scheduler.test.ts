import { describe, expect, it } from 'vitest';
import type {
  ScheduledPermissions,
  Schedule,
  ScheduledRun,
  ScheduledTaskInput,
} from '@atelier/shared';
import { FakeClock, flush } from './fake-clock.js';
import { InMemoryScheduleStore, type RunPatch } from './schedule-store.js';
import type { RunRequest } from './scheduled-runner.js';
import { MAX_TIMER_MS, TaskScheduler } from './task-scheduler.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Remplaçant de `nextRunAt` (L0, testé dans shared) : intervalle depuis
 * `after`, ou prochaine heure locale `HH:MM` strictement après `after`.
 */
function nextRunAt(schedule: Schedule, after: Date): Date {
  if (schedule.kind === 'interval') {
    return new Date(after.getTime() + schedule.every * (schedule.unit === 'hours' ? HOUR : MIN));
  }
  if (schedule.kind !== 'daily') throw new Error('non couvert par le remplaçant');
  const [h, m] = schedule.time.split(':').map(Number);
  const next = new Date(after);
  next.setHours(h ?? 0, m ?? 0, 0, 0);
  if (next <= after) next.setDate(next.getDate() + 1);
  return next;
}

function validateSchedule(schedule: Schedule): string | undefined {
  if (schedule.kind === 'interval' && schedule.every * (schedule.unit === 'hours' ? 60 : 1) < 15) {
    return 'Au moins toutes les 15 minutes.';
  }
  return undefined;
}

const POLICY: ScheduledPermissions = {
  fileWrite: true,
  commands: false,
  webDomains: [],
  mcpTools: [],
};

const input = (overrides: Partial<ScheduledTaskInput> = {}): ScheduledTaskInput => ({
  name: 'Rapport',
  prompt: 'Fais le rapport',
  workspace: '/w',
  schedule: { kind: 'daily', time: '08:00' },
  permissions: POLICY,
  ...overrides,
});

/** Exécuteur contrôlé par le test : chaque run attend `finish`. */
function controlledExecutor() {
  const started: RunRequest[] = [];
  const pending = new Map<string, (patch: RunPatch) => void>();
  const execute = (request: RunRequest): Promise<RunPatch> => {
    started.push(request);
    return new Promise<RunPatch>((resolve) => {
      pending.set(request.runId, resolve);
      request.signal.addEventListener('abort', () => {
        resolve({ status: 'aborted' });
      });
    });
  };
  const finish = async (runId: string, patch: RunPatch = { status: 'success' }): Promise<void> => {
    pending.get(runId)?.(patch);
    await flush();
  };
  return { started, execute, finish };
}

function setup(start = '2026-10-31T07:00:00') {
  const clock = new FakeClock(start);
  const store = new InMemoryScheduleStore();
  const executor = controlledExecutor();
  const changes: { taskId: string; run?: ScheduledRun }[] = [];
  const finished: ScheduledRun[] = [];
  let n = 0;
  const scheduler = new TaskScheduler({
    store,
    clock,
    execute: executor.execute,
    nextRunAt,
    validateSchedule,
    onChange: (change) => changes.push(change),
    onFinished: (_task, run) => finished.push(run),
    newId: () => `id${String((n += 1))}`,
  });
  return { clock, store, scheduler, changes, finished, ...executor };
}

describe('TaskScheduler', () => {
  it('lance le run à l’heure prévue, puis réarme sur l’occurrence suivante', async () => {
    const { clock, scheduler, started, finish, store, finished } = setup('2026-10-31T07:00:00');
    scheduler.start();
    const task = scheduler.saveTask(input());
    expect(task.nextRunAt).toBe(new Date('2026-10-31T08:00:00').toISOString());

    await clock.advance(59 * MIN);
    expect(started).toHaveLength(0);
    await clock.advance(MIN);
    expect(started).toHaveLength(1);
    expect(store.runs()[0]).toMatchObject({ trigger: 'schedule', status: 'queued' });
    await finish(started[0]?.runId ?? '');
    expect(finished.map((r) => r.status)).toEqual(['success']);
    expect(store.getTask(task.id)?.nextRunAt).toBe(new Date('2026-11-01T08:00:00').toISOString());
  });

  it('le minuteur est plafonné à une heure', () => {
    const { clock, scheduler } = setup('2026-10-31T09:00:00');
    scheduler.start();
    scheduler.saveTask(input()); // demain 08:00
    expect(clock.pending()).toEqual([MAX_TIMER_MS]);
  });

  it('rattrapage : une seule exécution après trois occurrences manquées', async () => {
    const { clock, scheduler, store, started } = setup('2026-10-31T07:00:00');
    scheduler.start();
    scheduler.saveTask(input());
    scheduler.stop();
    // Mac éteint trois jours : aucun minuteur ne s'est déclenché.
    clock.jump(3 * 24 * HOUR + HOUR);
    scheduler.start();
    await flush();
    expect(started).toHaveLength(1);
    expect(store.runs()).toHaveLength(1);
    expect(store.runs()[0]?.trigger).toBe('catch_up');
    // La suivante repart de maintenant (03/11 08:00), pas des occurrences manquées.
    expect(store.listTasks()[0]?.nextRunAt).toBe(new Date('2026-11-04T08:00:00').toISOString());
  });

  it('pas de chevauchement : l’occurrence est sautée (overlap) si la tâche tourne encore', async () => {
    const { clock, scheduler, store, started, finished } = setup('2026-10-31T07:00:00');
    scheduler.start();
    scheduler.saveTask(input({ schedule: { kind: 'interval', every: 15, unit: 'minutes' } }));
    await clock.advance(15 * MIN);
    expect(started).toHaveLength(1);
    await clock.advance(15 * MIN);
    expect(started).toHaveLength(1);
    const runs = store.runs();
    expect(runs[0]).toMatchObject({ status: 'skipped', skipReason: 'overlap' });
    // Une occurrence sautée ne déclenche pas de notification.
    expect(finished).toEqual([]);
  });

  it('file FIFO : un seul run à la fois, dans l’ordre d’arrivée', async () => {
    const { scheduler, started, finish } = setup();
    scheduler.start();
    const a = scheduler.saveTask(input({ name: 'A' }));
    const b = scheduler.saveTask(input({ name: 'B' }));
    scheduler.runNow(a.id);
    scheduler.runNow(b.id);
    await flush();
    expect(started.map((r) => r.task.name)).toEqual(['A']);
    await finish(started[0]?.runId ?? '');
    expect(started.map((r) => r.task.name)).toEqual(['A', 'B']);
  });

  it('au redémarrage, un run resté ouvert passe en « interrupted »', () => {
    const { store, scheduler, changes } = setup();
    store.saveTask({
      ...input(),
      id: 't1',
      maxDurationMinutes: 20,
      enabled: true,
      createdAt: 'a',
      updatedAt: 'a',
    });
    store.createRun({
      id: 'r1',
      taskId: 't1',
      trigger: 'schedule',
      status: 'running',
      scheduledFor: '2026-10-31T06:00:00.000Z',
      files: [],
      denied: [],
    });
    scheduler.start();
    expect(store.getRun('r1')?.status).toBe('interrupted');
    expect(changes[0]?.run?.status).toBe('interrupted');
  });

  it('« Arrêter » : un run en file est retiré, un run en cours est annulé', async () => {
    const { scheduler, started, store } = setup();
    scheduler.start();
    const a = scheduler.saveTask(input({ name: 'A' }));
    const b = scheduler.saveTask(input({ name: 'B' }));
    const runA = scheduler.runNow(a.id);
    const runB = scheduler.runNow(b.id);
    await scheduler.stopRun(runB.id);
    expect(store.getRun(runB.id)?.status).toBe('aborted');
    await scheduler.stopRun(runA.id);
    await flush();
    expect(store.getRun(runA.id)?.status).toBe('aborted');
    expect(started).toHaveLength(1);
  });

  it('valide la tâche : nom, prompt, dossier, récurrence (plancher), durée maximale', () => {
    const { scheduler } = setup();
    expect(() => scheduler.saveTask(input({ name: ' ' }))).toThrow('Donnez un nom à la tâche.');
    expect(() => scheduler.saveTask(input({ prompt: '' }))).toThrow(/demande/);
    expect(() =>
      scheduler.saveTask(input({ schedule: { kind: 'interval', every: 5, unit: 'minutes' } })),
    ).toThrow('Au moins toutes les 15 minutes.');
    expect(() => scheduler.saveTask(input({ maxDurationMinutes: 200 }))).toThrow(/entre 5 et 120/);
    expect(scheduler.saveTask(input()).maxDurationMinutes).toBe(20);
    // Code et champ transmis au renderer, qui affiche le message sous ce champ.
    expect(() => scheduler.saveTask(input({ name: '' }))).toThrow(
      expect.objectContaining({ code: 'schedule/invalid', details: { field: 'name' } }),
    );
    // Intervalle de 10 min : message de validateSchedule, champ « schedule ».
    expect(() =>
      scheduler.saveTask(input({ schedule: { kind: 'interval', every: 10, unit: 'minutes' } })),
    ).toThrow(
      expect.objectContaining({
        code: 'schedule/invalid',
        message: 'Au moins toutes les 15 minutes.',
        details: { field: 'schedule' },
      }),
    );
    expect(() => scheduler.runNow('absente')).toThrow(
      expect.objectContaining({ code: 'schedule/not_found' }),
    );
  });

  it('renommer une tâche garde sa prochaine exécution ; changer la récurrence la recalcule', async () => {
    const { clock, scheduler } = setup('2026-10-31T07:00:00');
    scheduler.start();
    const every = { kind: 'interval' as const, every: 60, unit: 'minutes' as const };
    const task = scheduler.saveTask(input({ schedule: every }));
    await clock.advance(20 * MIN);
    expect(scheduler.saveTask(input({ schedule: every, name: 'Autre' }), task.id).nextRunAt).toBe(
      task.nextRunAt,
    );
    const changed = scheduler.saveTask(input({ schedule: { ...every, every: 30 } }), task.id);
    expect(changed.nextRunAt).toBe(new Date('2026-10-31T07:50:00').toISOString());
  });

  it('désactivée : plus de prochaine exécution ; réactivée : repart de maintenant', () => {
    const { scheduler } = setup('2026-10-31T09:00:00');
    scheduler.start();
    const task = scheduler.saveTask(input());
    expect(scheduler.setEnabled(task.id, false).nextRunAt).toBeUndefined();
    expect(scheduler.setEnabled(task.id, true).nextRunAt).toBe(
      new Date('2026-11-01T08:00:00').toISOString(),
    );
  });

  it('suppression : le run en cours est arrêté, la tâche et ses runs disparaissent', async () => {
    const { scheduler, store } = setup();
    scheduler.start();
    const task = scheduler.saveTask(input());
    scheduler.runNow(task.id);
    await flush();
    await scheduler.deleteTask(task.id);
    await flush();
    expect(store.listTasks()).toEqual([]);
    expect(store.runs()).toEqual([]);
  });

  it('purge les runs de plus de 90 jours au démarrage', () => {
    const { store, scheduler } = setup('2026-10-31T07:00:00');
    store.saveTask({
      ...input(),
      id: 't1',
      maxDurationMinutes: 20,
      enabled: false,
      createdAt: 'a',
      updatedAt: 'a',
    });
    for (const [id, at] of [
      ['vieux', '2026-07-01T08:00:00.000Z'],
      ['récent', '2026-10-01T08:00:00.000Z'],
    ] as const) {
      store.createRun({
        id,
        taskId: 't1',
        trigger: 'schedule',
        status: 'success',
        scheduledFor: at,
        files: [],
        denied: [],
      });
    }
    scheduler.start();
    expect(store.runs().map((r) => r.id)).toEqual(['récent']);
  });
});
