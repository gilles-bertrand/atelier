/**
 * Tests d'intégration avec une vraie VM Lima.
 *
 * Skippés hors macOS arm64 et sans `ATELIER_SANDBOX_IT=1` (les runners CI macOS
 * n'ont pas de virtualisation imbriquée). Prérequis : `pnpm fetch:lima`.
 *
 *   ATELIER_SANDBOX_IT=1 pnpm --filter @atelier/sandbox test lima.integration
 *
 * Utilise une instance dédiée (`atelier-it`) dans un LIMA_HOME séparé ; la VM est
 * arrêtée (pas supprimée) à la fin pour accélérer les relances, sauf avec
 * `ATELIER_SANDBOX_IT_DELETE=1`. Le premier lancement (téléchargement + provisioning)
 * prend 10 à 20 minutes selon la connexion.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SandboxProgress } from '@atelier/shared';
import { LimaSandbox, Limactl } from '../src/index.js';

const enabled =
  process.platform === 'darwin' &&
  process.arch === 'arm64' &&
  process.env['ATELIER_SANDBOX_IT'] === '1';

const REPO = resolve(import.meta.dirname, '../../..');
const MINUTE = 60_000;
const limactlPath = join(REPO, 'apps/desktop/resources/lima/bin/limactl');
const limaHome =
  process.env['ATELIER_SANDBOX_IT_LIMA_HOME'] ??
  join(homedir(), 'Library', 'Application Support', 'Atelier', 'lima-it');

describe.skipIf(!enabled)('LimaSandbox avec une vraie VM', () => {
  let sandbox: LimaSandbox;
  let root: string;
  let workspace: string;
  let skillsDir: string;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-it-')));
    workspace = join(root, 'projet');
    skillsDir = join(root, 'skills');
    await mkdir(workspace);
    await mkdir(join(skillsDir, 'demo'), { recursive: true });
    await writeFile(join(skillsDir, 'demo', 'SKILL.md'), '---\nname: demo\n---\nBonjour\n');
    sandbox = new LimaSandbox({
      limactlPath,
      templatesDir: join(REPO, 'lima'),
      limaHome,
      instanceName: 'atelier-it',
      skillsDir,
      log: (message) => {
        console.log(`[sandbox] ${message}`);
      },
    });
  });

  afterAll(async () => {
    console.log('[sandbox] durées (ms) :', JSON.stringify(timings));
    console.log('[sandbox] diagnostics :', JSON.stringify((await sandbox.diagnostics()).extra));
    await sandbox.stop();
    if (process.env['ATELIER_SANDBOX_IT_DELETE'] === '1') {
      await new Limactl({ limactlPath, limaHome }).delete('atelier-it');
    }
    await rm(root, { recursive: true, force: true });
  }, 2 * MINUTE);

  it(
    'démarre (et provisionne si besoin) la VM',
    async () => {
      const progress: SandboxProgress[] = [];
      await sandbox.setWorkspace(workspace);
      const started = Date.now();
      await sandbox.ensureReady((p) => {
        progress.push(p);
        console.log(`[sandbox] ${p.phase} ${String(p.progress ?? '')} ${p.message}`);
      });
      timings['ensureReady'] = Date.now() - started;
      expect(sandbox.status()).toMatchObject({ state: 'ready', workspace, networkEnabled: false });
      expect(progress.at(-1)?.phase).toBe('ready');
    },
    40 * MINUTE,
  );

  it('exécute des commandes en tant que agent dans /workspace', async () => {
    const who = await sandbox.exec('whoami && pwd');
    expect(who.stdout).toBe('agent\n/workspace\n');
    expect((await sandbox.exec('exit 7')).exitCode).toBe(7);
    const err = await sandbox.exec('echo oups >&2; false');
    expect(err).toMatchObject({ exitCode: 1, stderr: 'oups\n' });
    // Pas de sudo pour agent.
    expect((await sandbox.exec('sudo -n true')).exitCode).not.toBe(0);
  });

  it('dispose des outils provisionnés (python, pandas, node 22, exceljs)', async () => {
    const py = await sandbox.exec('python3 -c \'import pandas, openpyxl; print("ok")\'');
    expect(py.stdout.trim()).toBe('ok');
    const node = await sandbox.exec(
      "node -e \"require('exceljs'); console.log(process.versions.node.split('.')[0])\"",
    );
    expect(node.stdout.trim()).toBe('22');
    expect((await sandbox.exec('command -v pdftoppm')).exitCode).toBe(0);
  });

  it('écrit dans /workspace de façon visible côté hôte', async () => {
    const result = await sandbox.exec('mkdir -p sortie && printf "Été 2026\\n" > sortie/résumé.md');
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(workspace, 'sortie', 'résumé.md'), 'utf8')).toBe('Été 2026\n');
    await writeFile(join(workspace, 'depuis-hote.txt'), 'hôte');
    expect((await sandbox.exec('cat depuis-hote.txt')).stdout).toBe('hôte');
  });

  it('monte /skills en lecture seule', async () => {
    expect((await sandbox.exec('cat /skills/demo/SKILL.md')).stdout).toContain('Bonjour');
    const write = await sandbox.exec('touch /skills/interdit.txt');
    expect(write.exitCode).not.toBe(0);
    expect(write.stderr).toMatch(/read-only|lecture seule/i);
  });

  it('ne voit pas le dossier personnel de l’hôte', async () => {
    const result = await sandbox.exec(`ls ${JSON.stringify(homedir())}`);
    expect(result.exitCode).not.toBe(0);
  });

  it(
    'bloque le réseau de agent, puis l’autorise, puis le recoupe',
    async () => {
      const probe = 'curl -sS -o /dev/null -m 15 -w "%{http_code}" https://example.com';
      const blocked = await sandbox.exec(probe, { timeoutMs: 30_000 });
      expect(blocked.exitCode).not.toBe(0);
      // SearXNG local et DNS aussi bloqués quand le réseau est coupé.
      const search = await sandbox.exec('curl -sS -m 5 http://127.0.0.1:8888/healthz');
      expect(search.exitCode).not.toBe(0);

      await sandbox.setNetwork(true);
      const allowed = await sandbox.exec(probe, { timeoutMs: 30_000 });
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toBe('200');

      await sandbox.setNetwork(false);
      expect((await sandbox.exec(probe, { timeoutMs: 30_000 })).exitCode).not.toBe(0);
    },
    2 * MINUTE,
  );

  it('SearXNG répond en JSON sur 127.0.0.1:8888 côté hôte', async () => {
    const health = await fetch('http://127.0.0.1:8888/healthz');
    expect(health.status).toBe(200);
    const search = await fetch('http://127.0.0.1:8888/search?q=lima+vm&format=json');
    expect(search.status).toBe(200);
    const body: unknown = await search.json();
    expect(body).toHaveProperty('results');
  });

  it('tue une commande au délai', async () => {
    const started = Date.now();
    const result = await sandbox.exec('sleep 60 & sleep 60; echo fini', { timeoutMs: 2_000 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
    // Aucun `sleep` orphelin : tout le groupe de processus a été tué.
    expect((await sandbox.exec('pgrep -u agent -x sleep')).exitCode).toBe(1);
  });

  it(
    'change de dossier de travail en moins de 15 s',
    async () => {
      const other = join(root, 'autre projet');
      await mkdir(other);
      await writeFile(join(other, 'données.csv'), 'mois,total\n');
      const started = Date.now();
      await sandbox.setWorkspace(other);
      timings['setWorkspace'] = Date.now() - started;
      console.log(`[sandbox] setWorkspace : ${String(timings['setWorkspace'])} ms`);
      expect((await sandbox.exec('cat données.csv')).stdout).toBe('mois,total\n');
      expect(sandbox.toGuestPath(join(other, 'données.csv'))).toBe('/workspace/données.csv');
      expect(timings['setWorkspace']).toBeLessThan(15_000);
    },
    3 * MINUTE,
  );
});
