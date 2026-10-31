import { describe, expect, it } from 'vitest';
import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  IPC_PRELOAD_ONLY_CHANNELS,
  IPC_RENDERER_INVOKE_CHANNELS,
} from '../src/index.js';

describe('canaux IPC', () => {
  it('le renderer ne peut pas invoquer attachment:import (chemins hôte réservés au preload)', () => {
    expect(IPC_RENDERER_INVOKE_CHANNELS).not.toContain('attachment:import');
    expect(IPC_INVOKE_CHANNELS).toContain('attachment:import');
  });

  it('canaux du renderer + canaux du preload = tous les canaux', () => {
    expect([...IPC_RENDERER_INVOKE_CHANNELS, ...IPC_PRELOAD_ONLY_CHANNELS].sort()).toEqual(
      [...IPC_INVOKE_CHANNELS].sort(),
    );
  });

  it('expose mcp:status en invocation et en événement', () => {
    expect(IPC_RENDERER_INVOKE_CHANNELS).toContain('mcp:status');
    expect(IPC_EVENT_CHANNELS).toContain('mcp:status');
    expect(IPC_RENDERER_INVOKE_CHANNELS).toContain('dialog:choose-directory');
    expect(IPC_RENDERER_INVOKE_CHANNELS).toContain('app:health');
    expect(IPC_RENDERER_INVOKE_CHANNELS).toContain('session:set-model');
  });

  it('expose les tâches planifiées au renderer (ADR-002)', () => {
    for (const channel of [
      'schedule:list',
      'schedule:save',
      'schedule:delete',
      'schedule:set-enabled',
      'schedule:run-now',
      'schedule:stop-run',
      'schedule:dashboard',
      'schedule:runs',
    ] as const) {
      expect(IPC_RENDERER_INVOKE_CHANNELS).toContain(channel);
    }
    expect(IPC_EVENT_CHANNELS).toContain('schedule:changed');
    expect(IPC_EVENT_CHANNELS).toContain('app:open-session');
  });

  it('expose les projets et les artefacts au renderer (ADR-003)', () => {
    for (const channel of [
      'project:list',
      'project:get',
      'project:create',
      'project:update',
      'project:set-archived',
      'project:delete',
      'project:from-folder',
      'project:memory',
      'project:memory-save',
      'project:memory-history',
      'artifact:list',
      'artifact:get',
      'artifact:versions',
      'artifact:delete',
    ] as const) {
      expect(IPC_RENDERER_INVOKE_CHANNELS).toContain(channel);
    }
    expect(IPC_EVENT_CHANNELS).toContain('project:changed');
    expect(IPC_EVENT_CHANNELS).toContain('artifact:changed');
  });
});
