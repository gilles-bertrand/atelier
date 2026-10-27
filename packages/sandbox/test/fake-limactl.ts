/**
 * Faux `limactl` (et `sysctl`) pour les tests unitaires : simule l'état d'une
 * instance et enregistre chaque appel.
 */
import { OutputCollector } from '../src/output.js';
import type { CommandRunner, RunOptions, RunResult } from '../src/runner.js';
import type { LimaMount } from '../src/limactl.js';

export interface FakeCall {
  file: string;
  args: string[];
  options: RunOptions;
}

export interface FakeExecResult {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  timedOut?: boolean;
}

interface FakeState {
  exists: boolean;
  status: 'Running' | 'Stopped';
  mounts: LimaMount[];
  cpus: number;
  memoryBytes: number;
  stamp: string | undefined;
  network: 'on' | 'off';
}

export interface FakeLimactlOptions {
  hvSupport?: string;
  /** Erreur JSON renvoyée par `limactl start` (exit 1). */
  startError?: string;
  /** Code de sortie du provisioning. */
  provisionExitCode?: number;
  /** Réponse aux commandes de l'agent. */
  onExec?: (command: string, call: FakeCall) => FakeExecResult;
}

function makeResult(
  options: RunOptions,
  { exitCode = 0, stdout = '', stderr = '', durationMs = 5, timedOut = false }: FakeExecResult,
): RunResult {
  const capture = options.captureBytes ?? 1024 * 1024;
  const out = new OutputCollector(capture);
  const err = new OutputCollector(capture);
  out.push(Buffer.from(stdout));
  err.push(Buffer.from(stderr));
  for (const line of stdout.split('\n')) if (line) options.onStdoutLine?.(line);
  for (const line of stderr.split('\n')) if (line) options.onStderrLine?.(line);
  return { exitCode, signal: null, stdout: out, stderr: err, timedOut, aborted: false, durationMs };
}

const log = (msg: string, level = 'info'): string => JSON.stringify({ level, msg, time: 'now' });

export class FakeLimactl {
  readonly calls: FakeCall[] = [];
  readonly state: FakeState = {
    exists: false,
    status: 'Stopped',
    mounts: [],
    cpus: 4,
    memoryBytes: 4 * 1024 ** 3,
    stamp: undefined,
    network: 'off',
  };

  constructor(private readonly options: FakeLimactlOptions = {}) {}

  /** Appels limactl (sans le binaire), pour les assertions. */
  limactlArgs(): string[][] {
    return this.calls.filter((c) => c.file !== '/usr/sbin/sysctl').map((c) => c.args);
  }

  /** Sous-commandes limactl appelées, dans l'ordre (`create`, `start`…). */
  verbs(): string[] {
    return this.limactlArgs().map((args) => {
      const verb = args[0] ?? '';
      if (verb !== 'shell') return verb;
      const rest = args.slice(args.indexOf('--') + 1);
      return `shell:${rest.includes('/usr/local/bin/atelier-exec') ? 'exec' : rest.join(' ').slice(0, 40)}`;
    });
  }

  readonly runner: CommandRunner = (file, args, options = {}) => {
    const call: FakeCall = { file, args: [...args], options };
    this.calls.push(call);
    return Promise.resolve(this.handle(call));
  };

  private applySets(args: string[]): void {
    for (const arg of args) {
      if (!arg.startsWith('--set=.mounts = ')) continue;
      this.state.mounts = JSON.parse(arg.slice('--set=.mounts = '.length)) as LimaMount[];
    }
    for (const arg of args) {
      if (arg.startsWith('--cpus=')) this.state.cpus = Number(arg.slice(7));
      if (arg.startsWith('--memory=')) this.state.memoryBytes = Number(arg.slice(9)) * 1024 ** 3;
    }
  }

  private handle(call: FakeCall): RunResult {
    const { file, args, options } = call;
    if (file === '/usr/sbin/sysctl') {
      return makeResult(options, { stdout: `${this.options.hvSupport ?? '1'}\n` });
    }
    const verb = args[0];
    switch (verb) {
      case '--version':
        return makeResult(options, { stdout: 'limactl version 2.2.1\n' });
      case 'list': {
        if (!this.state.exists) return makeResult(options, {});
        const instance = {
          name: 'atelier',
          status: this.state.status,
          dir: '/fake/lima/atelier',
          vmType: 'vz',
          arch: 'aarch64',
          cpus: this.state.cpus,
          memory: this.state.memoryBytes,
          disk: 30 * 1024 ** 3,
          config: { mounts: this.state.mounts },
        };
        return makeResult(options, { stdout: `${JSON.stringify(instance)}\n` });
      }
      case 'create':
        this.state.exists = true;
        this.state.status = 'Stopped';
        this.applySets(args);
        return makeResult(options, { stderr: log('Attempting to download the image') });
      case 'start':
        if (this.options.startError) {
          return makeResult(options, {
            exitCode: 1,
            stderr: log(this.options.startError, 'fatal'),
          });
        }
        this.state.status = 'Running';
        this.state.network = 'off'; // fail-closed au démarrage
        return makeResult(options, {
          stderr: [
            log('Starting the instance "atelier" with internal VM driver "vz"'),
            log('Waiting for the essential requirement 1 of 2: "ssh"'),
            log('READY. Run `limactl shell atelier` to open the shell.'),
          ].join('\n'),
        });
      case 'stop':
        this.state.status = 'Stopped';
        return makeResult(options, {});
      case 'edit':
        if (this.state.status === 'Running') {
          return makeResult(options, {
            exitCode: 1,
            stderr: log('cannot edit a running instance', 'fatal'),
          });
        }
        this.applySets(args);
        return makeResult(options, {});
      case 'delete':
        this.state.exists = false;
        this.state.stamp = undefined;
        this.state.mounts = [];
        return makeResult(options, {});
      case 'shell':
        return this.handleShell(call);
      default:
        return makeResult(options, { exitCode: 1, stderr: `unknown verb ${String(verb)}` });
    }
  }

  private handleShell(call: FakeCall): RunResult {
    const { args, options } = call;
    const rest = args.slice(args.indexOf('--') + 1);
    if (this.state.status !== 'Running') {
      return makeResult(options, {
        exitCode: 255,
        stderr: 'ssh: connect to host 127.0.0.1 port 60022: Connection refused',
      });
    }
    if (rest[0] === 'cat' && rest[1] === '/var/lib/atelier/provisioned') {
      return this.state.stamp === undefined
        ? makeResult(options, { exitCode: 1, stderr: 'No such file' })
        : makeResult(options, { stdout: `${this.state.stamp}\n` });
    }
    if (rest.join(' ') === 'sudo bash -s') {
      const exitCode = this.options.provisionExitCode ?? 0;
      if (exitCode === 0) {
        this.state.stamp = /echo ([0-9a-f]+) > \/var\/lib\/atelier\/provisioned/.exec(
          options.input ?? '',
        )?.[1];
      }
      return makeResult(options, {
        exitCode,
        stdout: '::atelier:: 8 Installation de Python…\n::atelier:: 100 Provisioning terminé.\n',
        stderr: exitCode === 0 ? '' : 'E: Unable to locate package\n',
      });
    }
    if (rest[0] === 'sudo' && rest[1] === '/usr/local/sbin/atelier-network') {
      this.state.network = rest[2] === 'on' ? 'on' : 'off';
      return makeResult(options, { stdout: `${this.state.network}\n` });
    }
    const execIndex = rest.indexOf('/usr/local/bin/atelier-exec');
    if (execIndex !== -1) {
      const command = rest[execIndex + 3] ?? '';
      return makeResult(options, this.options.onExec?.(command, call) ?? { stdout: '' });
    }
    if (rest.includes('/usr/local/bin/atelier-kill')) return makeResult(options, {});
    return makeResult(options, { exitCode: 127, stderr: `commande inconnue : ${rest.join(' ')}` });
  }
}
