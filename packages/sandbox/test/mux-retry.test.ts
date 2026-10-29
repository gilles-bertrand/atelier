/** Relance unique de `limactl shell` sur une erreur de multiplexage SSH (#85). */
import { describe, expect, it } from 'vitest';
import { isSshMuxFailure, Limactl } from '../src/limactl.js';
import { OutputCollector } from '../src/output.js';
import type { CommandRunner, RunResult } from '../src/runner.js';

const MUX_STDERR =
  'mm_send_fd: sendmsg(0): Message too long\nmux_client_request_session: send fds failed\n';

interface Attempt {
  exitCode: number;
  stderr?: string;
  stdout?: string;
}

function result({ exitCode, stderr = '', stdout = '' }: Attempt): RunResult {
  const out = new OutputCollector(1024);
  const err = new OutputCollector(1024);
  out.push(Buffer.from(stdout));
  err.push(Buffer.from(stderr));
  return {
    exitCode,
    signal: null,
    stdout: out,
    stderr: err,
    timedOut: false,
    aborted: false,
    durationMs: 5,
  };
}

/**
 * Faux limactl : rejoue les tentatives dans l'ordre. Une tentative qui n'échoue pas
 * sur le mux ouvre la session et exécute donc la commande (compteur `executions`).
 */
function scripted(attempts: Attempt[]): {
  limactl: Limactl;
  calls: string[][];
  executions: () => number;
  logs: string[];
} {
  const calls: string[][] = [];
  const logs: string[] = [];
  let executions = 0;
  const runner: CommandRunner = (_file, args) => {
    calls.push([...args]);
    const attempt = attempts[calls.length - 1] ?? { exitCode: 0 };
    const res = result(attempt);
    if (!isSshMuxFailure(res)) executions += 1;
    return Promise.resolve(res);
  };
  const limactl = new Limactl({
    limactlPath: '/fake/limactl',
    limaHome: '/fake/lima',
    runner,
    baseEnv: {},
    log: (message) => logs.push(message),
  });
  return { limactl, calls, executions: () => executions, logs };
}

describe('limactl shell : erreur de multiplexage SSH (#85)', () => {
  it('erreur mux puis succès : une relance, puis le succès', async () => {
    const { limactl, calls, logs } = scripted([
      { exitCode: 255, stderr: MUX_STDERR },
      { exitCode: 0, stdout: 'ok\n' },
    ]);
    const res = await limactl.shell('atelier', ['echo', 'ok'], { workdir: '/workspace' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.render().text).toBe('ok\n');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/\[warn\].*relance unique.*mux_client_request_session/);
  });

  it('erreur mux deux fois : le second échec est renvoyé tel quel, sans autre relance', async () => {
    const second = `${MUX_STDERR}second\n`;
    const { limactl, calls } = scripted([
      { exitCode: 255, stderr: MUX_STDERR },
      { exitCode: 255, stderr: second },
      { exitCode: 0 },
    ]);
    const res = await limactl.shell('atelier', ['true']);
    expect(calls).toHaveLength(2);
    expect(res.exitCode).toBe(255);
    expect(res.stderr.render().text).toBe(second);
  });

  it('code 255 sans motif mux : pas de relance (une vraie commande peut sortir en 255)', async () => {
    const { limactl, calls, logs } = scripted([
      { exitCode: 255, stderr: 'erreur de la commande\n' },
      { exitCode: 0 },
    ]);
    const res = await limactl.shell('atelier', ['sh', '-c', 'exit 255']);
    expect(res.exitCode).toBe(255);
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it('motif mux avec un autre code : pas de relance', async () => {
    const { limactl, calls } = scripted([{ exitCode: 1, stderr: MUX_STDERR }, { exitCode: 0 }]);
    expect((await limactl.shell('atelier', ['true'])).exitCode).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('commande non idempotente : exécutée une seule fois malgré la relance', async () => {
    const { limactl, calls, executions } = scripted([
      { exitCode: 255, stderr: MUX_STDERR },
      { exitCode: 0 },
    ]);
    await limactl.shell('atelier', ['sh', '-c', 'echo x >> /workspace/compteur.txt']);
    expect(calls).toHaveLength(2);
    expect(executions()).toBe(1);
  });

  it('pas de relance si la commande a été annulée', async () => {
    const { limactl, calls } = scripted([{ exitCode: 255, stderr: MUX_STDERR }, { exitCode: 0 }]);
    const controller = new AbortController();
    controller.abort();
    expect((await limactl.shell('atelier', ['true'], { signal: controller.signal })).exitCode).toBe(
      255,
    );
    expect(calls).toHaveLength(1);
  });
});
