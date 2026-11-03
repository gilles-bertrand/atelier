import { describe, expect, it } from 'vitest';
import { AtelierError, type Sandbox, type SandboxStatus } from '@atelier/shared';
import { DisabledSandbox } from './disabled-sandbox.js';
import { SandboxManager } from './sandbox-manager.js';

const REASON = 'VM désactivée pour une instance de test (--user-data-dir).';

describe('DisabledSandbox (ticket #41)', () => {
  it('reste « Indisponible » avec la raison, sans rien exécuter', async () => {
    // Utilisée par l'interface `Sandbox`, comme dans SandboxManager.
    const sandbox: Sandbox = new DisabledSandbox(REASON);
    expect(sandbox.status()).toEqual({ state: 'error', networkEnabled: false, error: REASON });
    await expect(sandbox.ensureReady()).rejects.toThrow(REASON);
    await expect(sandbox.reset()).rejects.toBeInstanceOf(AtelierError);
    await expect(sandbox.exec('ls')).rejects.toThrow(REASON);
    await expect(sandbox.setWorkspace('/tmp/projet')).resolves.toBeUndefined();
    await expect(sandbox.setNetwork(true)).resolves.toBeUndefined();
    await expect(sandbox.stop()).resolves.toBeUndefined();
    expect(sandbox.toGuestPath('/tmp/projet/a.txt')).toBeNull();
    expect(sandbox.toHostPath('/workspace/a.txt')).toBeNull();
    expect((await sandbox.diagnostics()).extra).toEqual({ disabled: REASON });
  });

  it('branchée comme dans index.ts : pas de VM au démarrage, au tour, ni en quittant', async () => {
    const published: SandboxStatus[] = [];
    const manager = new SandboxManager({
      create: () => new DisabledSandbox(REASON),
      preflight: () => Promise.resolve(REASON),
      onStatus: (status) => published.push(status),
      onProgress: () => undefined,
      defaultNetwork: () => false,
    });
    await expect(manager.ensureReady()).rejects.toThrow(REASON);
    expect(manager.status()).toMatchObject({ state: 'error', error: REASON });
    expect(published.at(-1)).toMatchObject({ state: 'error', error: REASON });
    await expect(manager.prepareForTurn('s1', '/tmp/projet')).resolves.toBeUndefined();
    expect(manager.current()).toBeUndefined();
    await expect(manager.reset()).rejects.toThrow(REASON);
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(manager.status()).toMatchObject({ state: 'error', error: REASON });
  });
});
