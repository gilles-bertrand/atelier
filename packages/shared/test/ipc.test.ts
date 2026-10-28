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
  });
});
