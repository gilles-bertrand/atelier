import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '@atelier/shared';
import type { SessionView } from '@renderer/state/chat-reducer';
import { sessionActivity } from './activity';

const view = (overrides: Partial<SessionView>): SessionView => ({
  messages: [],
  todos: [],
  permissions: [],
  loaded: true,
  ...overrides,
});

const request: PermissionRequest = {
  id: 'p1',
  sessionId: 'waiting',
  toolCallId: 'c1',
  toolName: 'bash',
  kind: 'command',
  title: 'Exécuter python3 build.py',
  input: {},
};

describe('sessionActivity', () => {
  it('signale le travail en cours et les accords attendus, rien pour une conversation au repos', () => {
    const activity = sessionActivity({
      running: view({ turn: { turnId: 't1', status: 'running' } }),
      waiting: view({ turn: { turnId: 't2', status: 'running' }, permissions: [request] }),
      done: view({ turn: { turnId: 't3', status: 'done' } }),
      idle: view({}),
    });
    expect([...activity]).toEqual([
      ['running', 'running'],
      ['waiting', 'waiting'],
    ]);
  });
});
