import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AtelierError, type SandboxProgress } from '@atelier/shared';
import { LimaSandbox, type LimaSandboxOptions } from '../src/index.js';
import { FakeLimactl, type FakeLimactlOptions } from './fake-limactl.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../../lima');

let root: string;
let limactlPath: string;
let workspace: string;
let otherWorkspace: string;
let skillsDir: string;
let limaHome: string;

beforeEach(async () => {
  // Chemin canonique (/var → /private/var sur macOS), comme le fait setWorkspace.
  root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-sandbox-test-')));
  limactlPath = join(root, 'bin', 'limactl');
  await mkdir(join(root, 'bin'));
  await writeFile(limactlPath, '#!/bin/sh\nexit 1\n');
  await chmod(limactlPath, 0o755);
  workspace = join(root, 'projet');
  otherWorkspace = join(root, 'autre projet');
  skillsDir = join(root, 'skills');
  limaHome = join(root, 'lima');
  await mkdir(workspace);
  await mkdir(otherWorkspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(
  fakeOptions: FakeLimactlOptions = {},
  options: Partial<LimaSandboxOptions> = {},
): { fake: FakeLimactl; sandbox: LimaSandbox } {
  const fake = new FakeLimactl(fakeOptions);
  const sandbox = new LimaSandbox({
    limactlPath,
    templatesDir: TEMPLATES_DIR,
    limaHome,
    skillsDir,
    runner: fake.runner,
    freeDiskBytes: () => Promise.resolve(100 * 1024 ** 3),
    platform: { os: 'darwin', arch: 'arm64' },
    ...options,
  });
  return { fake, sandbox };
}

async function readySandbox(
  fakeOptions: FakeLimactlOptions = {},
  options: Partial<LimaSandboxOptions> = {},
): Promise<{ fake: FakeLimactl; sandbox: LimaSandbox }> {
  const ctx = setup(fakeOptions, options);
  await ctx.sandbox.setWorkspace(workspace);
  await ctx.sandbox.ensureReady();
  ctx.fake.calls.length = 0;
  return ctx;
}

async function expectAtelierError(promise: Promise<unknown>, code: string): Promise<AtelierError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AtelierError);
  expect((error as AtelierError).code).toBe(code);
  return error as AtelierError;
}

describe('LimaSandbox.ensureReady', () => {
  it('crée, démarre et provisionne la VM au premier lancement, avec une progression lisible', async () => {
    const { fake, sandbox } = setup();
    await sandbox.setWorkspace(workspace);
    const progress: SandboxProgress[] = [];
    await sandbox.ensureReady((p) => progress.push(p));

    expect(fake.verbs()).toEqual([
      'list',
      'create',
      'start',
      'list',
      'shell:cat /var/lib/atelier/provisioned',
      'shell:sudo bash -s',
      'shell:sudo /usr/local/sbin/atelier-network off',
    ]);
    const create = fake.limactlArgs()[1] ?? [];
    expect(create).toContain('--name=atelier');
    expect(create).toContain('--cpus=4');
    expect(create).toContain('--memory=4');
    expect(create.at(-1)).toBe(join(TEMPLATES_DIR, 'atelier.yaml'));
    expect(fake.state.mounts).toEqual([
      { location: workspace, mountPoint: '/workspace', writable: true },
      { location: skillsDir, mountPoint: '/skills', writable: false },
    ]);
    // LIMA_HOME injecté dans l'environnement de limactl.
    expect(fake.calls[1]?.options.env?.['LIMA_HOME']).toBe(limaHome);

    const phases = progress.map((p) => p.phase);
    expect(phases[0]).toBe('checking');
    expect(phases).toContain('creating');
    expect(phases).toContain('downloading_image');
    expect(phases).toContain('starting');
    expect(phases).toContain('provisioning');
    expect(phases.at(-1)).toBe('ready');
    expect(progress.map((p) => p.message)).toContain('Installation de Python…');
    const values = progress.map((p) => p.progress ?? 0);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(sandbox.status()).toEqual({ state: 'ready', workspace, networkEnabled: false });
  });

  it('se contente de démarrer une VM existante déjà provisionnée', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.stop();
    fake.calls.length = 0;

    const again = setup();
    Object.assign(again.fake.state, fake.state);
    await again.sandbox.setWorkspace(workspace);
    await again.sandbox.ensureReady();
    expect(again.fake.verbs()).toEqual([
      'list',
      'start',
      'list',
      'shell:cat /var/lib/atelier/provisioned',
      'shell:sudo /usr/local/sbin/atelier-network off',
    ]);
  });

  it('est idempotent quand la VM est déjà prête', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.ensureReady();
    expect(fake.verbs()).toEqual(['list']);
  });

  it('reprend une VM déjà démarrée (app relancée) sans la redémarrer', async () => {
    const first = await readySandbox();
    const { fake, sandbox } = setup();
    Object.assign(fake.state, first.fake.state);
    await sandbox.setWorkspace(workspace);
    await sandbox.ensureReady();
    expect(fake.verbs()).not.toContain('start');
    expect(fake.verbs()).not.toContain('stop');
    expect(sandbox.status().state).toBe('ready');
  });

  it('refuse un Mac sans virtualisation', async () => {
    const { sandbox } = setup({ hvSupport: '0' });
    await expectAtelierError(sandbox.ensureReady(), 'sandbox/virtualization_unavailable');
    expect(sandbox.status().state).toBe('error');
  });

  it('refuse une plateforme autre que macOS arm64', async () => {
    const { sandbox } = setup({}, { platform: { os: 'linux', arch: 'x64' } });
    await expectAtelierError(sandbox.ensureReady(), 'sandbox/virtualization_unavailable');
  });

  it('refuse de créer la VM si le disque est presque plein', async () => {
    const { fake, sandbox } = setup({}, { freeDiskBytes: () => Promise.resolve(2 * 1024 ** 3) });
    const error = await expectAtelierError(sandbox.ensureReady(), 'sandbox/disk_full');
    expect(error.message).toMatch(/2\.0 Go libres/);
    expect(fake.verbs()).not.toContain('create');
  });

  it('traduit les erreurs de limactl (disque plein, virtualisation)', async () => {
    const disk = setup({ startError: 'failed to create disk: write /x: no space left on device' });
    await expectAtelierError(disk.sandbox.ensureReady(), 'sandbox/disk_full');
    const vz = setup({
      startError:
        'Error Domain=VZErrorDomain Code=1 "Virtualization is not available on this hardware."',
    });
    await expectAtelierError(vz.sandbox.ensureReady(), 'sandbox/virtualization_unavailable');
  });

  it('signale un provisioning en échec et le reprend au lancement suivant', async () => {
    const failing = setup({ provisionExitCode: 1 });
    const error = await expectAtelierError(failing.sandbox.ensureReady(), 'sandbox/failed');
    expect(error.retryable).toBe(true);
    expect(failing.fake.state.stamp).toBeUndefined();
  });

  it("signale clairement l'absence de limactl", async () => {
    const { sandbox } = setup({}, { limactlPath: join(root, 'absent', 'limactl') });
    const error = await expectAtelierError(sandbox.ensureReady(), 'sandbox/failed');
    expect(error.message).toMatch(/fetch:lima/);
  });

  it('applique les ressources des Réglages à une VM arrêtée', async () => {
    const first = await readySandbox();
    await first.sandbox.stop();
    const { fake, sandbox } = setup({}, { resources: { cpus: 6, memoryGiB: 8 } });
    Object.assign(fake.state, first.fake.state);
    await sandbox.setWorkspace(workspace);
    await sandbox.ensureReady();
    const edit = fake.limactlArgs().find((args) => args[0] === 'edit') ?? [];
    expect(edit).toContain('--cpus=6');
    expect(edit).toContain('--memory=8');
    expect(edit.some((a) => a.startsWith('--set='))).toBe(false); // montages inchangés
  });
});

describe('LimaSandbox.setWorkspace', () => {
  it('remonte /workspace et redémarre la VM', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.setWorkspace(otherWorkspace);
    expect(fake.verbs()).toEqual([
      'stop',
      'edit',
      'start',
      'list',
      'shell:cat /var/lib/atelier/provisioned',
      'shell:sudo /usr/local/sbin/atelier-network off',
    ]);
    expect(fake.state.mounts[0]).toEqual({
      location: otherWorkspace,
      mountPoint: '/workspace',
      writable: true,
    });
    expect(sandbox.status().workspace).toBe(otherWorkspace);
    expect(sandbox.toGuestPath(join(otherWorkspace, 'a', 'b.txt'))).toBe('/workspace/a/b.txt');
    const diag = await sandbox.diagnostics();
    expect(diag.extra?.['timings']).toHaveProperty('lastWorkspaceSwitchMs');
  });

  it('ne redémarre pas si le dossier ne change pas', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.setWorkspace(workspace);
    expect(fake.verbs()).toEqual([]);
  });

  it('enregistre le dossier sans démarrer la VM si elle ne tourne pas', async () => {
    const { fake, sandbox } = setup();
    await sandbox.setWorkspace(workspace);
    expect(fake.verbs()).toEqual([]);
  });

  it('résout les liens symboliques', async () => {
    const link = join(root, 'lien');
    await symlink(otherWorkspace, link);
    const { fake, sandbox } = await readySandbox();
    await sandbox.setWorkspace(link);
    expect(fake.state.mounts[0]?.location).toBe(otherWorkspace);
  });

  it.each([
    ['la racine', '/'],
    ['le dossier personnel', homedir()],
    ['un parent du dossier personnel', resolve(homedir(), '..')],
    ['un chemin relatif', 'projet'],
  ])('refuse %s', async (_label, dir) => {
    const { sandbox } = setup();
    await expectAtelierError(sandbox.setWorkspace(dir), 'sandbox/invalid_workspace');
  });

  it('refuse les données de Lima et le dossier des skills', async () => {
    const { sandbox } = setup();
    await mkdir(join(limaHome, 'atelier'), { recursive: true });
    await mkdir(join(skillsDir, 'xlsx'), { recursive: true });
    await expectAtelierError(
      sandbox.setWorkspace(join(limaHome, 'atelier')),
      'sandbox/invalid_workspace',
    );
    await expectAtelierError(
      sandbox.setWorkspace(join(skillsDir, 'xlsx')),
      'sandbox/invalid_workspace',
    );
    await expectAtelierError(sandbox.setWorkspace(root), 'sandbox/invalid_workspace');
  });

  it('refuse un dossier inexistant', async () => {
    const { sandbox } = setup();
    await expectAtelierError(sandbox.setWorkspace(join(root, 'nope')), 'tool/failed');
  });
});

describe('LimaSandbox.exec', () => {
  it('relance une fois une commande refusée par le multiplexage SSH (#85)', async () => {
    const logs: string[] = [];
    let attempts = 0;
    const { fake, sandbox } = await readySandbox(
      {
        onExec: () => {
          attempts += 1;
          return attempts === 1
            ? {
                exitCode: 255,
                stderr:
                  'mm_send_fd: sendmsg(0): Message too long\nmux_client_request_session: send fds failed\n',
              }
            : { stdout: 'ok\n' };
        },
      },
      { log: (message) => logs.push(message) },
    );
    const result = await sandbox.exec('echo ok');
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok\n' });
    expect(fake.verbs()).toEqual(['shell:exec', 'shell:exec']);
    expect(logs.some((m) => m.includes('relance unique'))).toBe(true);
  });

  it('exécute la commande en tant que agent dans /workspace', async () => {
    const { fake, sandbox } = await readySandbox({
      onExec: () => ({ exitCode: 3, stdout: 'bonjour\n', stderr: 'attention\n' }),
    });
    const result = await sandbox.exec("echo 'bonjour' && exit 3", { env: { FOO: 'bar baz' } });
    expect(result).toMatchObject({
      exitCode: 3,
      stdout: 'bonjour\n',
      stderr: 'attention\n',
      truncated: false,
      timedOut: false,
    });
    const args = fake.limactlArgs()[0] ?? [];
    expect(args.slice(0, 4)).toEqual(['shell', '--tty=false', '--workdir=/workspace', 'atelier']);
    const rest = args.slice(args.indexOf('--') + 1);
    expect(rest.slice(0, 5)).toEqual(['sudo', '-u', 'agent', '-H', '--']);
    expect(rest).toContain('FOO=bar baz');
    expect(rest.at(-2)).toBe('120');
    expect(rest.at(-1)).toBe("echo 'bonjour' && exit 3");
  });

  it('tronque la sortie à 10 ko en gardant le début et la fin', async () => {
    const big = `DEBUT${'x'.repeat(50_000)}FIN`;
    const { sandbox } = await readySandbox({ onExec: () => ({ stdout: big }) });
    const result = await sandbox.exec('cat gros.txt');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(10_240 + 100);
    expect(result.stdout.startsWith('DEBUT')).toBe(true);
    expect(result.stdout.endsWith('FIN')).toBe(true);
    expect(result.stdout).toMatch(/octets tronqués/);
  });

  it('signale le dépassement de délai (code 124 de timeout dans la VM)', async () => {
    const { sandbox } = await readySandbox({
      onExec: () => ({ exitCode: 124, durationMs: 2_000 }),
    });
    const result = await sandbox.exec('sleep 10', { timeoutMs: 2_000 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/interrompue après 2 s/);
  });

  it("transmet le délai à la VM et une marge à l'hôte", async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.exec('true', { timeoutMs: 1_500, cwd: '/workspace/sous-dossier' });
    const call = fake.calls.find((c) => c.args[0] === 'shell');
    expect(call?.args).toContain('2');
    expect(call?.args).toContain('--workdir=/workspace/sous-dossier');
    expect(call?.options.timeoutMs).toBe(16_500);
  });

  it("refuse d'exécuter tant que la VM n'est pas prête", async () => {
    const { sandbox } = setup();
    await expectAtelierError(sandbox.exec('ls'), 'sandbox/not_ready');
  });

  it("refuse les noms de variables d'environnement invalides", async () => {
    const { sandbox } = await readySandbox();
    await expectAtelierError(
      sandbox.exec('env', { env: { 'A;rm -rf /': 'x' } }),
      'tool/invalid_input',
    );
  });

  it("distingue une VM injoignable (ssh) d'un code de sortie 255", async () => {
    const { fake, sandbox } = await readySandbox();
    fake.state.status = 'Stopped';
    await expectAtelierError(sandbox.exec('ls'), 'sandbox/not_ready');
  });
});

describe('LimaSandbox.setNetwork', () => {
  it('ouvre puis coupe le réseau de agent via nftables', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.setNetwork(true);
    expect(fake.state.network).toBe('on');
    expect(sandbox.status().networkEnabled).toBe(true);
    await sandbox.setNetwork(false);
    expect(fake.state.network).toBe('off');
    expect(fake.verbs()).toEqual([
      'shell:sudo /usr/local/sbin/atelier-network on',
      'shell:sudo /usr/local/sbin/atelier-network off',
    ]);
  });

  it('réapplique le choix après un redémarrage (la VM redémarre réseau coupé)', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.setNetwork(true);
    await sandbox.setWorkspace(otherWorkspace);
    expect(fake.state.network).toBe('on');
  });

  it("mémorise le choix si la VM n'est pas démarrée", async () => {
    const { fake, sandbox } = setup();
    await sandbox.setNetwork(true);
    expect(fake.verbs()).toEqual([]);
    await sandbox.setWorkspace(workspace);
    await sandbox.ensureReady();
    expect(fake.state.network).toBe('on');
  });
});

describe('LimaSandbox.stop / reset / diagnostics', () => {
  it('arrête la VM', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.stop();
    expect(fake.verbs()).toEqual(['list', 'stop']);
    expect(sandbox.status().state).toBe('stopped');
    expect(sandbox.status().workspace).toBeUndefined();
  });

  it('supprime puis recrée la VM', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.reset();
    expect(fake.verbs().slice(0, 4)).toEqual(['list', 'delete', 'list', 'create']);
    expect(fake.verbs()).toContain('shell:sudo bash -s');
    expect(sandbox.status().state).toBe('ready');
    expect(fake.state.mounts[0]?.location).toBe(workspace);
  });

  it('expose un diagnostic issu de limactl list --json', async () => {
    const { sandbox } = await readySandbox();
    const diag = await sandbox.diagnostics();
    expect(diag).toMatchObject({
      limaVersion: '2.2.1',
      limaHome,
      rawStatus: 'Running',
      resources: { cpus: 4, memoryGiB: 4, diskGiB: 30 },
    });
    expect(diag.extra?.['instance']).toMatchObject({ vmType: 'vz', arch: 'aarch64' });
  });

  it('sérialise les opérations de cycle de vie concurrentes', async () => {
    const { fake, sandbox } = setup();
    await sandbox.setWorkspace(workspace);
    await Promise.all([sandbox.ensureReady(), sandbox.ensureReady(), sandbox.setNetwork(true)]);
    expect(fake.verbs().filter((v) => v === 'create')).toHaveLength(1);
    expect(fake.state.network).toBe('on');
  });
});

describe('LimaSandbox chemins', () => {
  it('convertit les chemins hôte ↔ VM', async () => {
    const { sandbox } = await readySandbox();
    expect(sandbox.toGuestPath(workspace)).toBe('/workspace');
    expect(sandbox.toGuestPath(join(workspace, 'données', 'ventes.csv'))).toBe(
      '/workspace/données/ventes.csv',
    );
    expect(sandbox.toGuestPath(join(skillsDir, 'xlsx', 'SKILL.md'))).toBe('/skills/xlsx/SKILL.md');
    expect(sandbox.toGuestPath(join(root, 'ailleurs.txt'))).toBeNull();
    expect(sandbox.toHostPath('/workspace/a/b.txt')).toBe(join(workspace, 'a', 'b.txt'));
    expect(sandbox.toHostPath('/workspace/../etc/passwd')).toBeNull();
    expect(sandbox.toHostPath('/skills/xlsx/SKILL.md')).toBe(join(skillsDir, 'xlsx', 'SKILL.md'));
    expect(sandbox.toHostPath('/etc/passwd')).toBeNull();
  });

  it('accepte un chemin hôte non résolu (lien symbolique dans le chemin)', async () => {
    const link = join(root, 'lien-projet');
    await symlink(workspace, link);
    const { sandbox } = await readySandbox();
    expect(sandbox.toGuestPath(join(link, 'nouveau', 'fichier.md'))).toBe(
      '/workspace/nouveau/fichier.md',
    );
  });
});
