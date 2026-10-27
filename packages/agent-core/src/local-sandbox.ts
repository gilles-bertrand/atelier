/**
 * Implémentation TEMPORAIRE (M1) de l'interface {@link Sandbox} avec
 * `child_process`, en attendant la VM Lima de `packages/sandbox`.
 *
 * ⚠️ Aucune isolation : les commandes tournent sur l'hôte, avec les droits de
 * l'utilisateur, dans le dossier de travail. Réservé à la CLI de démo et aux
 * tests ; l'app ne doit jamais l'utiliser.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  AtelierError,
  GUEST_WORKSPACE,
  type Sandbox,
  type SandboxDiagnostics,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxStatus,
} from '@atelier/shared';
import { isInside } from './paths.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 10_240;

/** Accumulateur de sortie borné. */
class BoundedBuffer {
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    if (this.#size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.#size;
    const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    if (part !== chunk) this.truncated = true;
    this.#chunks.push(part);
    this.#size += part.byteLength;
  }
  toString(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

export class LocalSandbox implements Sandbox {
  #workspace: string;
  #network = true;

  constructor(workspace: string) {
    this.#workspace = path.resolve(workspace);
  }

  ensureReady(): Promise<void> {
    return Promise.resolve();
  }

  setWorkspace(hostDir: string): Promise<void> {
    this.#workspace = path.resolve(hostDir);
    return Promise.resolve();
  }

  exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const cwd = options.cwd !== undefined ? this.toHostPath(options.cwd) : this.#workspace;
    if (cwd === null) {
      return Promise.reject(
        new AtelierError(
          'sandbox/failed',
          `Répertoire hors du dossier de travail : ${String(options.cwd)}`,
        ),
      );
    }
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: this.#workspace,
          LANG: 'C.UTF-8',
          ...options.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      const stdout = new BoundedBuffer(max);
      const stderr = new BoundedBuffer(max);
      let timedOut = false;
      const kill = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = (): void => {
        kill();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (c: Buffer) => {
        stdout.push(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        stderr.push(c);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(new AtelierError('sandbox/failed', error.message, { cause: error }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode: timedOut ? null : code,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          truncated: stdout.truncated || stderr.truncated,
          timedOut,
          durationMs: Date.now() - started,
        });
      });
    });
  }

  setNetwork(enabled: boolean): Promise<void> {
    // Sans VM, le réseau ne peut pas être coupé : l'état est seulement mémorisé.
    this.#network = enabled;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  reset(): Promise<void> {
    return Promise.resolve();
  }

  status(): SandboxStatus {
    return { state: 'ready', workspace: this.#workspace, networkEnabled: this.#network };
  }

  diagnostics(): Promise<SandboxDiagnostics> {
    return Promise.resolve({
      limaHome: '',
      rawStatus: 'local (sans isolation)',
      resources: { cpus: 0, memoryGiB: 0 },
      extra: { implementation: 'LocalSandbox' },
    });
  }

  toGuestPath(hostPath: string): string | null {
    const abs = path.resolve(hostPath);
    if (!isInside(this.#workspace, abs)) return null;
    const rel = path.relative(this.#workspace, abs).split(path.sep).join('/');
    return rel === '' ? GUEST_WORKSPACE : `${GUEST_WORKSPACE}/${rel}`;
  }

  toHostPath(guestPath: string): string | null {
    const normalized = path.posix.normalize(guestPath);
    if (normalized === GUEST_WORKSPACE) return this.#workspace;
    if (!normalized.startsWith(`${GUEST_WORKSPACE}/`)) return null;
    return path.join(this.#workspace, normalized.slice(GUEST_WORKSPACE.length + 1));
  }
}
