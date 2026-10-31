import { describe, expect, it } from 'vitest';
import type { Sandbox, SandboxHolder, SandboxStatus } from '@atelier/shared';
import { WorkspaceLease } from '../schedule/workspace-lease.js';
import { SandboxManager } from './sandbox-manager.js';

describe('SandboxManager : détenteur de la VM (ADR-002 D5)', () => {
  it('publie `heldBy` à chaque changement du bail, et seulement alors', () => {
    const published: SandboxStatus[] = [];
    let holder: () => SandboxHolder | undefined = () => undefined;
    const sandbox = new SandboxManager({
      create: () => ({}) as Sandbox,
      onStatus: (status) => published.push(status),
      onProgress: () => undefined,
      defaultNetwork: () => false,
      holder: () => holder(),
    });
    const lease = new WorkspaceLease({
      onChange: () => {
        sandbox.holderChanged();
      },
    });
    holder = () => lease.holder();

    const release = lease.tryAcquire({ workspace: '/w', runId: 'r1', taskName: 'Rapport' });
    expect(sandbox.status().heldBy).toEqual({ workspace: '/w', runId: 'r1', taskName: 'Rapport' });
    // Une conversation du même dossier : le run reste affiché (il peut être arrêté).
    const chat = lease.tryAcquire({ workspace: '/w', sessionId: 's1' });
    release?.();
    expect(sandbox.status().heldBy).toEqual({ workspace: '/w', sessionId: 's1' });
    chat?.();
    expect(sandbox.status().heldBy).toBeUndefined();
    expect(published.map((s) => s.heldBy)).toEqual([
      { workspace: '/w', runId: 'r1', taskName: 'Rapport' },
      { workspace: '/w', sessionId: 's1' },
      undefined,
    ]);
  });
});
