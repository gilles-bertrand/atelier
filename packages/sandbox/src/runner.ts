/**
 * Exécution de processus hôte (limactl, sysctl…), injectable pour les tests.
 */
import { spawn } from 'node:child_process';
import { AtelierError } from '@atelier/shared';
import { OutputCollector } from './output.js';

/** Options d'un lancement de processus. */
export interface RunOptions {
  /** Environnement complet du processus. */
  env?: NodeJS.ProcessEnv;
  /** Texte écrit sur l'entrée standard (puis fermée). */
  input?: string;
  /** Tue le processus (SIGKILL) au-delà de ce délai. */
  timeoutMs?: number;
  /** Annulation : tue le processus (SIGTERM puis SIGKILL). */
  signal?: AbortSignal;
  /** Octets conservés par flux (tête + queue). Défaut : 1 Mio. */
  captureBytes?: number;
  /** Reçoit chaque ligne complète de la sortie standard. */
  onStdoutLine?: (line: string) => void;
  /** Reçoit chaque ligne complète de la sortie d'erreur. */
  onStderrLine?: (line: string) => void;
}

/** Résultat d'un processus terminé. */
export interface RunResult {
  /** Code de sortie, `null` si tué par un signal. */
  exitCode: number | null;
  /** Signal ayant tué le processus. */
  signal: NodeJS.Signals | null;
  /** Sorties capturées (bornées par `captureBytes`). */
  stdout: OutputCollector;
  stderr: OutputCollector;
  /** Tué par `timeoutMs`. */
  timedOut: boolean;
  /** Tué par `signal`. */
  aborted: boolean;
  /** Durée en millisecondes. */
  durationMs: number;
}

/** Lance un processus et attend sa fin ; ne rejette que si le lancement échoue. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

const DEFAULT_CAPTURE_BYTES = 1024 * 1024;

/** Découpe un flux en lignes et appelle `onLine` pour chacune. */
function lineSplitter(onLine: (line: string) => void): {
  push: (chunk: Buffer) => void;
  flush: () => void;
} {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk.toString('utf8');
      let index = pending.indexOf('\n');
      while (index !== -1) {
        onLine(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    },
    flush() {
      if (pending.length > 0) onLine(pending);
      pending = '';
    },
  };
}

/** Implémentation par défaut, basée sur `child_process.spawn`. */
export const spawnRunner: CommandRunner = (file, args, options = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    const started = Date.now();
    const capture = options.captureBytes ?? DEFAULT_CAPTURE_BYTES;
    const stdout = new OutputCollector(capture);
    const stderr = new OutputCollector(capture);
    const outLines = options.onStdoutLine ? lineSplitter(options.onStdoutLine) : undefined;
    const errLines = options.onStderrLine ? lineSplitter(options.onStderrLine) : undefined;
    let timedOut = false;
    let aborted = false;

    if (options.signal?.aborted) {
      reject(new AtelierError('agent/aborted', 'Commande annulée avant son lancement.'));
      return;
    }

    const child = spawn(file, [...args], {
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    const kill = (sig: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            kill('SIGKILL');
          }, options.timeoutMs);
    let abortTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      aborted = true;
      kill('SIGTERM');
      abortTimer = setTimeout(() => {
        kill('SIGKILL');
      }, 3000);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      outLines?.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      errLines?.push(chunk);
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined); // processus terminé avant la fin de l'écriture
      child.stdin.end(options.input);
    }

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (abortTimer) clearTimeout(abortTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new AtelierError(
          'sandbox/failed',
          error.code === 'ENOENT'
            ? `Exécutable introuvable : ${file}`
            : `Lancement impossible de ${file} : ${error.message}`,
          { cause: error, details: { file } },
        ),
      );
    });
    child.on('close', (exitCode, signal) => {
      cleanup();
      outLines?.flush();
      errLines?.flush();
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      });
    });
  });
