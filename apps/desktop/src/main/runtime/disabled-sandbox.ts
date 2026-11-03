/**
 * Sandbox inerte d'une instance de test sans VM (ticket #41) : aucune commande
 * limactl, jamais. L'état reste « Indisponible » avec la raison, l'outil `bash`
 * répond « VM indisponible » au modèle, et quitter l'app n'arrête aucune VM.
 */
import {
  AtelierError,
  type Sandbox,
  type SandboxDiagnostics,
  type SandboxExecResult,
  type SandboxStatus,
} from '@atelier/shared';

export class DisabledSandbox implements Sandbox {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  ensureReady(): Promise<void> {
    return Promise.reject(this.#error());
  }

  /** Rien à monter : il n'y a pas de VM. */
  setWorkspace(): Promise<void> {
    return Promise.resolve();
  }

  exec(): Promise<SandboxExecResult> {
    return Promise.reject(this.#error());
  }

  setNetwork(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  /** Pas de VM à supprimer ni à recréer (Réglages › Réinitialiser). */
  reset(): Promise<void> {
    return Promise.reject(this.#error());
  }

  status(): SandboxStatus {
    return { state: 'error', networkEnabled: false, error: this.#reason };
  }

  diagnostics(): Promise<SandboxDiagnostics> {
    return Promise.resolve({
      limaHome: '',
      rawStatus: 'Désactivée',
      resources: { cpus: 0, memoryGiB: 0 },
      extra: { disabled: this.#reason },
    });
  }

  toGuestPath(): string | null {
    return null;
  }

  toHostPath(): string | null {
    return null;
  }

  #error(): AtelierError {
    return new AtelierError('sandbox/failed', this.#reason);
  }
}
