import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  IPC_RENDERER_INVOKE_CHANNELS,
  RELAUNCH_KINDS,
  type AgentEventType,
  type RelaunchKind,
} from '../src/index.js';

describe('contrat d’utilisation (ADR-001)', () => {
  it('RELAUNCH_KINDS couvre exactement RelaunchKind, sans doublon', () => {
    expectTypeOf<(typeof RELAUNCH_KINDS)[number]>().toEqualTypeOf<RelaunchKind>();
    expect(new Set(RELAUNCH_KINDS).size).toBe(RELAUNCH_KINDS.length);
  });

  it('usage:summary est invocable par le renderer', () => {
    expect(IPC_RENDERER_INVOKE_CHANNELS).toContain('usage:summary');
  });

  it('usage est un type d’AgentEvent', () => {
    expectTypeOf<'usage'>().toExtend<AgentEventType>();
  });
});
