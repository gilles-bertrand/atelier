import { describe, expect, it } from 'vitest';
import type { ScheduledRun } from '@atelier/shared';
import { runNotificationBody } from './notifications.js';

const run = (overrides: Partial<ScheduledRun>): ScheduledRun => ({
  id: 'r1',
  taskId: 't1',
  taskName: 'Rapport hebdo',
  trigger: 'schedule',
  status: 'success',
  scheduledFor: '2026-10-31T07:00:00.000Z',
  files: [],
  denied: [],
  ...overrides,
});

describe('notification de fin de run', () => {
  it('résume le résultat en français', () => {
    expect(runNotificationBody(run({}))).toBe('terminé');
    expect(runNotificationBody(run({ files: ['a.xlsx', 'b.pdf'] }))).toBe('terminé, 2 fichiers');
    expect(
      runNotificationBody(
        run({
          files: ['a.xlsx'],
          denied: [{ toolName: 'bash', kind: 'command', scopeKey: 'bash', title: 'ls' }],
        }),
      ),
    ).toBe('terminé, 1 fichier · 1 action refusée');
    expect(runNotificationBody(run({ status: 'error' }))).toBe('échec');
    expect(runNotificationBody(run({ status: 'timeout' }))).toBe(
      'arrêté : durée maximale dépassée',
    );
  });
});
