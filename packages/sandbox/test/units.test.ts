import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyLimaFailure, lastLimaError, parseLimaLogLine } from '../src/errors.js';
import { parseLimaList } from '../src/limactl.js';
import { currentMounts, mountsMatch, mountsSetExpression } from '../src/mounts.js';
import { OutputCollector, splitOutputBudget } from '../src/output.js';
import { guestToHost, hostToGuest, defaultLimaHome } from '../src/paths.js';
import { parseProvisionMarker, progressAt, progressFromLimaMessage } from '../src/progress.js';
import { loadProvisionScripts, provisionBundle, provisionVersion } from '../src/provision.js';
import { spawnRunner } from '../src/runner.js';
import {
  findChecksum,
  limaArchiveUrl,
  LIMA_FILES,
  LIMA_SHA256,
} from '../../../scripts/fetch-lima.js';

describe('OutputCollector', () => {
  it('rend la sortie intégrale si elle tient', () => {
    const c = new OutputCollector(100);
    c.push(Buffer.from('abc'));
    c.push(Buffer.from('déf'));
    expect(c.render()).toEqual({ text: 'abcdéf', truncated: false });
  });

  it('garde la tête et la queue, avec la mémoire bornée', () => {
    const c = new OutputCollector(20);
    for (let i = 0; i < 1000; i++) c.push(Buffer.from(`ligne ${String(i)}\n`));
    const { text, truncated } = c.render();
    expect(truncated).toBe(true);
    expect(text.startsWith('ligne 0\nli')).toBe(true);
    expect(text.endsWith('ligne 999\n')).toBe(true);
    expect(c.size).toBeGreaterThan(9000);
  });

  it('ne coupe jamais un caractère UTF-8 en deux', () => {
    const c = new OutputCollector(11);
    c.push(Buffer.from('ééééééééééééééééééé'));
    const { text } = c.render();
    expect(text).not.toContain('�');
  });

  it('répartit le budget entre stdout et stderr', () => {
    expect(splitOutputBudget(100, 50, 1000)).toEqual({ stdout: 100, stderr: 50 });
    expect(splitOutputBudget(5000, 5000, 1000)).toEqual({ stdout: 750, stderr: 250 });
    expect(splitOutputBudget(100, 5000, 1000)).toEqual({ stdout: 100, stderr: 900 });
  });
});

describe('journal et erreurs limactl', () => {
  it('parse les lignes JSON', () => {
    expect(parseLimaLogLine('{"level":"info","msg":"READY"}')).toMatchObject({
      level: 'info',
      msg: 'READY',
    });
    expect(parseLimaLogLine('texte')).toBeUndefined();
    expect(parseLimaLogLine('{"pas":"de msg"}')).toBeUndefined();
  });

  it('extrait la dernière erreur', () => {
    const stderr = [
      '{"level":"info","msg":"Starting"}',
      '{"level":"fatal","msg":"failed to start","error":"exit status 1"}',
    ].join('\n');
    expect(lastLimaError(stderr)).toBe('failed to start: exit status 1');
  });

  it.each([
    ['write: no space left on device', 'sandbox/disk_full'],
    ['Virtualization is not available on this hardware', 'sandbox/virtualization_unavailable'],
    ['VZErrorDomain Code=2', 'sandbox/virtualization_unavailable'],
    ['did not reach the running state within 10m0s', 'sandbox/timeout'],
    ['failed to download "https://cloud-images…": no such host', 'sandbox/failed'],
    ['quelque chose de bizarre', 'sandbox/failed'],
  ])('classe « %s »', (stderr, code) => {
    const error = classifyLimaFailure(
      JSON.stringify({ level: 'fatal', msg: stderr }),
      'démarrer la VM',
    );
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/démarrer la VM/);
  });
});

describe('progression', () => {
  it('traduit les messages de limactl', () => {
    expect(progressFromLimaMessage('Attempting to download the image')?.phase).toBe(
      'downloading_image',
    );
    expect(
      progressFromLimaMessage('Waiting for the essential requirement 1 of 2: "ssh"')?.phase,
    ).toBe('starting');
    expect(progressFromLimaMessage('[hostagent] Forwarding TCP')).toBeUndefined();
  });

  it('borne la progression dans la plage de chaque étape', () => {
    expect(progressAt('provisioning', 'x', 0).progress).toBe(0.4);
    expect(progressAt('provisioning', 'x', 2).progress).toBe(0.95);
    expect(progressAt('ready', 'x').progress).toBe(1);
  });

  it('parse les marqueurs des scripts de provisioning', () => {
    expect(parseProvisionMarker('::atelier:: 25 Installation des outils…')).toEqual({
      percent: 25,
      message: 'Installation des outils…',
    });
    expect(parseProvisionMarker('::atelier:: 250 x')?.percent).toBe(100);
    expect(parseProvisionMarker('Get:1 http://ports.ubuntu.com')).toBeUndefined();
  });
});

describe('provisioning', () => {
  const dir = resolve(import.meta.dirname, '../../../lima/provision');

  it('charge les scripts du dépôt dans l’ordre', async () => {
    const scripts = await loadProvisionScripts(dir);
    expect(scripts.map((s) => s.name)).toEqual(['10-packages.sh', '20-node.sh', '30-searxng.sh']);
    const all = scripts.map((s) => s.content).join('\n');
    for (const needle of [
      'python3-pandas',
      'python3-openpyxl',
      'poppler-utils',
      'exceljs@',
      'node_$NODE_MAJOR',
      'json',
      '8888',
    ]) {
      expect(all).toContain(needle);
    }
  });

  it('produit un script unique qui n’écrit le témoin qu’à la fin', () => {
    const scripts = [
      { name: '10-a.sh', content: 'echo a' },
      { name: '20-b.sh', content: 'echo b' },
    ];
    const version = provisionVersion(scripts);
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(provisionVersion([...scripts].reverse())).not.toBe(version);
    const bundle = provisionBundle(scripts, version);
    expect(bundle.indexOf('echo a')).toBeLessThan(bundle.indexOf('echo b'));
    expect(bundle.indexOf('rm -f /var/lib/atelier/provisioned')).toBeLessThan(
      bundle.indexOf('echo a'),
    );
    expect(bundle.lastIndexOf(`echo ${version} > /var/lib/atelier/provisioned`)).toBeGreaterThan(
      bundle.indexOf('echo b'),
    );
    expect(() => provisionBundle(scripts, '$(rm -rf /)')).toThrow();
  });
});

describe('montages', () => {
  it('génère une expression yq sûre (JSON)', () => {
    const expr = mountsSetExpression({
      workspace: '/Users/a/Mes "dossiers"',
      skillsDir: '/Users/a/Atelier/skills',
    });
    expect(expr.startsWith('.mounts = ')).toBe(true);
    expect(JSON.parse(expr.slice('.mounts = '.length))).toEqual([
      { location: '/Users/a/Mes "dossiers"', mountPoint: '/workspace', writable: true },
      { location: '/Users/a/Atelier/skills', mountPoint: '/skills', writable: false },
    ]);
  });

  it('compare les montages actuels et voulus', () => {
    const workspaceMount = { location: '/w', mountPoint: '/workspace', writable: true };
    const skillsMount = { location: '/s', mountPoint: '/skills', writable: false };
    const actual = [workspaceMount, skillsMount];
    expect(currentMounts(actual)).toEqual({ workspace: '/w', skillsDir: '/s' });
    expect(mountsMatch(actual, { workspace: '/w', skillsDir: '/s' })).toBe(true);
    expect(mountsMatch(actual, { workspace: '/x', skillsDir: '/s' })).toBe(false);
    expect(mountsMatch([{ location: '~' }, ...actual], { workspace: '/w', skillsDir: '/s' })).toBe(
      false,
    );
    // /skills monté en écriture : refusé.
    expect(
      mountsMatch([workspaceMount, { ...skillsMount, writable: true }], {
        workspace: '/w',
        skillsDir: '/s',
      }),
    ).toBe(false);
  });
});

describe('chemins', () => {
  const mounts = [{ host: '/Users/a/projet', guest: '/workspace' }];
  it('LIMA_HOME par défaut', () => {
    expect(defaultLimaHome('/Users/a')).toBe('/Users/a/Library/Application Support/Atelier/lima');
  });
  it('hôte → VM', () => {
    expect(hostToGuest('/Users/a/projet/x/y.txt', mounts)).toBe('/workspace/x/y.txt');
    expect(hostToGuest('/Users/a/projet-bis/y.txt', mounts)).toBeNull();
    expect(hostToGuest('/Users/a/projet/../secret', mounts)).toBeNull();
    expect(hostToGuest('relatif', mounts)).toBeNull();
  });
  it('VM → hôte', () => {
    expect(guestToHost('/workspace', mounts)).toBe('/Users/a/projet');
    expect(guestToHost('/workspace/x/../y', mounts)).toBe('/Users/a/projet/y');
    expect(guestToHost('/workspacex', mounts)).toBeNull();
    expect(guestToHost('/home/agent', mounts)).toBeNull();
  });
});

describe('parseLimaList', () => {
  it('parse une ligne JSON par instance', () => {
    const out = [
      JSON.stringify({
        name: 'atelier',
        status: 'Running',
        cpus: 4,
        memory: 4294967296,
        config: { mounts: [{ location: '/w', mountPoint: '/workspace', writable: true }] },
      }),
      JSON.stringify({ name: 'autre', status: 'Stopped' }),
    ].join('\n');
    const list = parseLimaList(out);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      name: 'atelier',
      status: 'Running',
      cpus: 4,
      mounts: [{ location: '/w', mountPoint: '/workspace', writable: true }],
    });
    expect(list[1]?.mounts).toEqual([]);
  });
  it('accepte un tableau JSON et ignore les entrées invalides', () => {
    expect(parseLimaList('[{"name":"a","status":"Stopped"},{"bad":true}]')).toHaveLength(1);
    expect(parseLimaList('')).toEqual([]);
  });
});

describe('spawnRunner', () => {
  it('capture le code de sortie, les sorties et les lignes', async () => {
    const lines: string[] = [];
    const result = await spawnRunner('/bin/sh', ['-c', 'printf "a\\nb\\n"; echo err >&2; exit 3'], {
      onStdoutLine: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(3);
    expect(lines).toEqual(['a', 'b']);
    expect(result.stderr.render().text).toBe('err\n');
  });

  it('transmet l’entrée standard', async () => {
    const result = await spawnRunner('/bin/cat', [], { input: 'bonjour' });
    expect(result.stdout.render().text).toBe('bonjour');
  });

  it('tue le processus au délai', async () => {
    const result = await spawnRunner('/bin/sleep', ['5'], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(2000);
  });

  it("tue le processus à l'annulation", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await spawnRunner('/bin/sleep', ['5'], { signal: controller.signal });
    expect(result.aborted).toBe(true);
  });

  it('rejette avec une AtelierError si le binaire est absent', async () => {
    await expect(spawnRunner('/nope/limactl', [])).rejects.toMatchObject({
      code: 'sandbox/failed',
    });
  });
});

describe('fetch-lima', () => {
  it('épingle une archive darwin-arm64 et son checksum', () => {
    expect(limaArchiveUrl('2.2.1')).toBe(
      'https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz',
    );
    expect(LIMA_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(LIMA_FILES).toContain('bin/limactl');
    expect(LIMA_FILES).toContain('share/lima/lima-guestagent.Linux-aarch64.gz');
  });

  it('lit un SHA256SUMS', () => {
    const sums = `${'a'.repeat(64)}  lima-2.2.1-Darwin-x86_64.tar.gz\n${'b'.repeat(64)}  lima-2.2.1-Darwin-arm64.tar.gz\n`;
    expect(findChecksum(sums, 'lima-2.2.1-Darwin-arm64.tar.gz')).toBe('b'.repeat(64));
    expect(findChecksum(sums, 'absent.tar.gz')).toBeUndefined();
  });
});

describe('template lima/atelier.yaml', () => {
  it('respecte les contraintes du brief', async () => {
    const yaml = await readFile(resolve(import.meta.dirname, '../../../lima/atelier.yaml'), 'utf8');
    expect(yaml).toMatch(/^vmType: vz$/m);
    expect(yaml).toMatch(/^arch: aarch64$/m);
    expect(yaml).toMatch(/^mountType: virtiofs$/m);
    expect(yaml).toMatch(/^mounts: \[\]$/m);
    expect(yaml).toMatch(/^cpus: 4$/m);
    expect(yaml).toMatch(/^memory: 4GiB$/m);
    expect(yaml).toMatch(/digest: 'sha256:[0-9a-f]{64}'/);
    expect(yaml).toContain('meta skuid "agent"');
    expect(yaml).toContain('guestPort: 8888');
    // Les contenus `data` sont des templates Go : pas de double accolade.
    expect(yaml).not.toContain('{{');
  });
});
