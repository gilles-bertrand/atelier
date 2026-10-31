import { describe, expect, it } from 'vitest';
import type { ChatMessage, PermissionRequest } from '@atelier/shared';
import type { UnattendedResult, UnattendedTurn } from '../runtime/chat-manager.js';
import type { ScheduledPermissions, ScheduledTask } from '@atelier/shared';
import { FakeClock, flush } from './fake-clock.js';
import type { RunPatch } from './schedule-store.js';
import {
  LEASE_WAIT_MS,
  producedFiles,
  runSummary,
  ScheduledRunner,
  type UnattendedHandlerFactory,
} from './scheduled-runner.js';
import { WorkspaceLease } from './workspace-lease.js';

const MIN = 60_000;

const task = (permissions: Partial<ScheduledPermissions> = {}): ScheduledTask => ({
  id: 't1',
  name: 'Rapport',
  prompt: 'Fais le rapport',
  workspace: '/w',
  schedule: { kind: 'daily', time: '08:00' },
  permissions: { fileWrite: true, commands: false, webDomains: [], mcpTools: [], ...permissions },
  maxDurationMinutes: 20,
  enabled: true,
  createdAt: 'a',
  updatedAt: 'a',
});

const answer = (text: string, files: string[] = []): ChatMessage => ({
  id: 'a1',
  sessionId: 's1',
  role: 'assistant',
  createdAt: 'a',
  parts: [
    ...files.map((path, i) => ({
      type: 'tool_call' as const,
      toolCallId: `c${String(i)}`,
      toolName: 'write_file',
      input: {},
      status: 'success' as const,
      display: {
        type: 'file' as const,
        file: { path, absolutePath: `/w/${path}`, action: 'created' as const },
      },
    })),
    { type: 'text', text },
  ],
});

const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'p1',
  sessionId: 's1',
  toolCallId: 'c1',
  toolName: 'bash',
  kind: 'command',
  title: 'Lancer ls',
  scopeKey: 'bash',
  input: {},
  ...overrides,
});

type Behaviour = (turn: UnattendedTurn) => Promise<Omit<UnattendedResult, 'turnId'>>;

function setup(behaviour: Behaviour, options: { lease?: WorkspaceLease; clock?: FakeClock } = {}) {
  const clock = options.clock ?? new FakeClock('2026-10-31T08:00:00');
  const lease = options.lease ?? new WorkspaceLease({ clock });
  const sessions: { workspace: string; options: unknown }[] = [];
  const turns: UnattendedTurn[] = [];
  const updates: RunPatch[] = [];
  let awake = 0;
  const factory: UnattendedHandlerFactory = (policy, onDenied) => (req) => {
    const allowed = req.kind === 'file_write' && policy.fileWrite;
    if (!allowed) {
      onDenied({
        toolName: req.toolName,
        kind: req.kind,
        scopeKey: req.scopeKey ?? req.toolName,
        title: req.title,
      });
    }
    return Promise.resolve(allowed ? 'allow_once' : 'deny');
  };
  const runner = new ScheduledRunner({
    chats: {
      create: (workspace, opts) => {
        sessions.push({ workspace, options: opts });
        return { id: 's1', title: 'x', workspace, createdAt: 'a', updatedAt: 'a' };
      },
      runUnattended: async (_sessionId, _text, turn) => {
        turns.push(turn);
        return { turnId: 'turn1', ...(await behaviour(turn)) };
      },
    },
    lease,
    permissionHandler: factory,
    instructions: 'Tu travailles seul.',
    clock,
    keepAwake: () => {
      awake += 1;
      return () => {
        awake -= 1;
      };
    },
    title: () => 'Rapport · 31/10 08:00',
  });
  const execute = (t: ScheduledTask, signal = new AbortController().signal): Promise<RunPatch> =>
    runner.execute({ runId: 'r1', task: t, signal, update: (p) => updates.push(p) });
  return { runner, execute, sessions, turns, updates, lease, clock, awake: () => awake };
}

describe('ScheduledRunner', () => {
  it('réussi : conversation liée à la tâche, compte rendu, fichiers produits, consignes', async () => {
    const { execute, sessions, turns, updates, awake } = setup(() =>
      Promise.resolve({
        reason: 'stop',
        message: answer('J’ai fait le rapport.\nFichier : rapport.xlsx', ['rapport.xlsx']),
      }),
    );
    const final = await execute(task());
    expect(final).toMatchObject({
      status: 'success',
      turnId: 'turn1',
      files: ['rapport.xlsx'],
      denied: [],
    });
    expect(sessions[0]).toEqual({
      workspace: '/w',
      options: { scheduledTaskId: 't1', title: 'Rapport · 31/10 08:00' },
    });
    expect(updates[0]).toMatchObject({ status: 'running', sessionId: 's1' });
    expect(turns[0]).toMatchObject({ instructions: 'Tu travailles seul.', useSandbox: false });
    expect(awake()).toBe(0);
  });

  it('refus enregistrés dans `denied` ; le run reste réussi', async () => {
    const { execute } = setup(async (turn) => {
      await turn.requestPermission(request());
      await turn.requestPermission(request({ kind: 'file_write', toolName: 'write_file' }));
      return { reason: 'stop', message: answer('Fait, sauf la commande.') };
    });
    const final = await execute(task());
    expect(final.status).toBe('success');
    expect(final.denied).toEqual([
      { toolName: 'bash', kind: 'command', scopeKey: 'bash', title: 'Lancer ls' },
    ]);
  });

  it('« timeout » à la durée maximale', async () => {
    const clock = new FakeClock('2026-10-31T08:00:00');
    const { execute } = setup(
      (turn) =>
        new Promise((resolve) => {
          turn.signal?.addEventListener('abort', () => {
            resolve({ reason: 'aborted', message: answer('Interrompu') });
          });
        }),
      { clock },
    );
    const pending = execute(task());
    await flush();
    await clock.advance(20 * MIN);
    expect((await pending).status).toBe('timeout');
  });

  it('erreur du modèle (max_steps, serveur) : statut « error »', async () => {
    const error = { code: 'llm/model_not_found' as const, message: 'absent', retryable: false };
    const { execute } = setup(() =>
      Promise.resolve({ reason: 'error', error, message: answer('') }),
    );
    expect(await execute(task())).toMatchObject({ status: 'error', error });
    const { execute: steps } = setup(() =>
      Promise.resolve({ reason: 'max_steps', message: answer('…') }),
    );
    expect((await steps(task())).status).toBe('error');
  });

  it('sans commandes : jamais bloqué par la VM tenue ailleurs', async () => {
    const { execute, lease } = setup(() =>
      Promise.resolve({ reason: 'stop', message: answer('Ok') }),
    );
    lease.tryAcquire({ workspace: '/ailleurs' });
    expect((await execute(task())).status).toBe('success');
  });

  it('avec commandes, VM tenue dans un autre dossier : attente, puis « skipped/busy » après 30 min', async () => {
    const clock = new FakeClock('2026-10-31T08:00:00');
    const { execute, lease, turns } = setup(
      () => Promise.resolve({ reason: 'stop', message: answer('Ok') }),
      { clock },
    );
    lease.tryAcquire({ workspace: '/ailleurs' });
    const pending = execute(task({ commands: true }));
    await clock.advance(LEASE_WAIT_MS - MIN);
    expect(turns).toHaveLength(0);
    await clock.advance(MIN);
    expect(await pending).toMatchObject({ status: 'skipped', skipReason: 'busy' });
  });

  it('avec commandes : démarre dès que la VM se libère, et tient le bail pendant le run', async () => {
    const clock = new FakeClock('2026-10-31T08:00:00');
    const lease = new WorkspaceLease({ clock });
    let heldDuringRun: unknown;
    const { execute } = setup(
      (turn) => {
        heldDuringRun = lease.holder();
        expect(turn.useSandbox).toBe(true);
        return Promise.resolve({ reason: 'stop', message: answer('Ok') });
      },
      { clock, lease },
    );
    const release = lease.tryAcquire({ workspace: '/ailleurs' });
    const pending = execute(task({ commands: true }));
    await clock.advance(5 * MIN);
    release?.();
    expect((await pending).status).toBe('success');
    expect(heldDuringRun).toEqual({ runId: 'r1', taskName: 'Rapport', workspace: '/w' });
    expect(lease.workspace()).toBeUndefined();
  });

  it('arrêté pendant l’attente de la VM : « aborted »', async () => {
    const { execute, lease } = setup(() =>
      Promise.resolve({ reason: 'stop', message: answer('Ok') }),
    );
    lease.tryAcquire({ workspace: '/ailleurs' });
    const controller = new AbortController();
    const pending = execute(task({ commands: true }), controller.signal);
    controller.abort();
    expect((await pending).status).toBe('aborted');
  });
});

describe('compte rendu et fichiers', () => {
  it('cinq premières lignes non vides du dernier texte, 500 caractères au plus', () => {
    const text = ['Bilan', '', 'a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    expect(runSummary(answer(text))).toBe('Bilan\na\nb\nc\nd');
    expect(runSummary(answer('x'.repeat(600)))?.length).toBe(500);
    expect(runSummary(answer(''))).toBeUndefined();
  });

  it('fichiers créés ou modifiés, sans doublon ni fichier seulement présenté', () => {
    const message = answer('Ok', ['a.xlsx', 'a.xlsx']);
    message.parts.push({
      type: 'tool_call',
      toolCallId: 'p',
      toolName: 'present_file',
      input: {},
      status: 'success',
      display: {
        type: 'file',
        file: { path: 'b.pdf', absolutePath: '/w/b.pdf', action: 'presented' },
      },
      files: [{ path: 'c.csv', absolutePath: '/w/c.csv', action: 'modified' }],
    });
    expect(producedFiles(message)).toEqual(['a.xlsx', 'c.csv']);
  });
});

describe('WorkspaceLease', () => {
  it('même dossier : partagé ; autre dossier : attend la libération, dans l’ordre', async () => {
    const lease = new WorkspaceLease();
    const a = lease.tryAcquire({ workspace: '/a' });
    expect(lease.tryAcquire({ workspace: '/a' })).toBeDefined();
    expect(lease.tryAcquire({ workspace: '/b' })).toBeUndefined();
    const order: string[] = [];
    void lease.acquire({ workspace: '/b' }).then(() => order.push('b'));
    void lease.acquire({ workspace: '/c' }).then(() => order.push('c'));
    a?.();
    await flush();
    // Le second détenteur de /a tient encore la VM.
    expect(order).toEqual([]);
  });

  it('signale le run qui tient la VM (Composer : « Arrêter »)', () => {
    const seen: unknown[] = [];
    const lease = new WorkspaceLease({ onChange: (run) => seen.push(run) });
    const release = lease.tryAcquire({
      workspace: '/w',
      runId: 'r1',
      taskName: 'Rapport',
    });
    release?.();
    release?.();
    expect(seen).toEqual([{ runId: 'r1', taskName: 'Rapport', workspace: '/w' }, undefined]);
  });
});
