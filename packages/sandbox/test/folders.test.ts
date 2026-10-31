/** Dossiers rattachés d'un projet montés sous /dossiers (ADR-003 D1). */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AtelierError, type SandboxFolderMount } from '@atelier/shared';
import { LimaSandbox } from '../src/index.js';
import {
  assertMountableFolders,
  currentMounts,
  isFolderMountPoint,
  mountsMatch,
  mountsSetExpression,
  sameFolderMounts,
} from '../src/mounts.js';
import { FakeLimactl } from './fake-limactl.js';

const TEMPLATES_DIR = resolve(import.meta.dirname, '../../../lima');

let root: string;
let limactlPath: string;
let workspace: string;
let compta: string;
let archives: string;
let skillsDir: string;
let limaHome: string;

beforeEach(async () => {
  // Sous /tmp (socket de Lima court, #46), chemin canonique comme setWorkspace.
  root = await realpath(await mkdtemp(join('/tmp', 'atelier-fold-')));
  limactlPath = join(root, 'bin', 'limactl');
  await mkdir(join(root, 'bin'));
  await writeFile(limactlPath, '#!/bin/sh\nexit 1\n');
  await chmod(limactlPath, 0o755);
  workspace = join(root, 'projet');
  compta = join(root, 'compta');
  archives = join(root, 'archives');
  skillsDir = join(root, 'skills');
  limaHome = join(root, 'lima');
  for (const dir of [workspace, compta, archives]) await mkdir(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const folders = (): SandboxFolderMount[] => [
  { host: compta, guest: '/dossiers/Compta', writable: true },
  { host: archives, guest: '/dossiers/Archives', writable: false },
];

async function readySandbox(): Promise<{ fake: FakeLimactl; sandbox: LimaSandbox }> {
  const fake = new FakeLimactl();
  const sandbox = new LimaSandbox({
    limactlPath,
    templatesDir: TEMPLATES_DIR,
    limaHome,
    skillsDir,
    runner: fake.runner,
    freeDiskBytes: () => Promise.resolve(100 * 1024 ** 3),
    platform: { os: 'darwin', arch: 'arm64' },
  });
  await sandbox.setWorkspace(workspace);
  await sandbox.ensureReady();
  fake.calls.length = 0;
  return { fake, sandbox };
}

async function expectAtelierError(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AtelierError);
  expect((error as AtelierError).code).toBe(code);
}

describe('montages des dossiers rattachés', () => {
  it('ajoute chaque dossier entre /workspace et /skills, en lecture seule si besoin', () => {
    const expression = mountsSetExpression({ workspace, skillsDir, folders: folders() });
    const list = JSON.parse(expression.slice('.mounts = '.length)) as unknown;
    expect(list).toEqual([
      { location: workspace, mountPoint: '/workspace', writable: true },
      { location: compta, mountPoint: '/dossiers/Compta', writable: true },
      { location: archives, mountPoint: '/dossiers/Archives', writable: false },
      { location: skillsDir, mountPoint: '/skills', writable: false },
    ]);
  });

  it('relit les dossiers montés et compare les listes sans tenir compte de l’ordre', () => {
    const actual = [
      { location: workspace, mountPoint: '/workspace', writable: true },
      { location: archives, mountPoint: '/dossiers/Archives', writable: false },
      { location: compta, mountPoint: '/dossiers/Compta', writable: true },
      { location: skillsDir, mountPoint: '/skills', writable: false },
    ];
    expect(currentMounts(actual).folders).toEqual([
      { host: archives, guest: '/dossiers/Archives', writable: false },
      { host: compta, guest: '/dossiers/Compta', writable: true },
    ]);
    expect(mountsMatch(actual, { workspace, skillsDir, folders: folders() })).toBe(true);
    // Accès changé, dossier en moins ou en plus : la configuration ne correspond plus.
    const comptaMount: SandboxFolderMount = {
      host: compta,
      guest: '/dossiers/Compta',
      writable: true,
    };
    const archivesRw: SandboxFolderMount = {
      host: archives,
      guest: '/dossiers/Archives',
      writable: true,
    };
    expect(mountsMatch(actual, { workspace, skillsDir, folders: [comptaMount, archivesRw] })).toBe(
      false,
    );
    expect(mountsMatch(actual, { workspace, skillsDir, folders: [comptaMount] })).toBe(false);
    expect(mountsMatch(actual, { workspace, skillsDir })).toBe(false);
    expect(sameFolderMounts([], undefined)).toBe(true);
  });

  it('n’accepte que /dossiers/<nom> comme point de montage', () => {
    expect(isFolderMountPoint('/dossiers/Compta-2026')).toBe(true);
    expect(isFolderMountPoint('/dossiers/rapport_v2.final')).toBe(true);
    for (const bad of [
      '/dossiers',
      '/dossiers/',
      '/dossiers/..',
      '/dossiers/.cache',
      '/dossiers/a/b',
      '/workspace',
      undefined,
    ]) {
      expect(isFolderMountPoint(bad)).toBe(false);
    }
  });

  it('refuse un dossier interdit, imbriqué ou en double', () => {
    const forbidden = { limaHome, skillsDir, home: root };
    expect(() => {
      assertMountableFolders(workspace, folders(), forbidden);
    }).not.toThrow();
    const refused = (list: SandboxFolderMount[], home = root): void => {
      expect(() => {
        assertMountableFolders(workspace, list, { limaHome, skillsDir, home });
      }).toThrow(AtelierError);
    };
    refused([{ host: join(workspace, 'sous'), guest: '/dossiers/Sous', writable: false }]);
    refused([{ host: root, guest: '/dossiers/Tout', writable: true }], homedir());
    refused([
      { host: compta, guest: '/dossiers/Compta', writable: true },
      { host: join(compta, '2026'), guest: '/dossiers/C2026', writable: false },
    ]);
    refused([
      { host: compta, guest: '/dossiers/X', writable: true },
      { host: archives, guest: '/dossiers/X', writable: false },
    ]);
    refused([{ host: compta, guest: '/dossiers/../etc', writable: true }]);
    refused([{ host: root, guest: '/dossiers/Home', writable: true }]); // $HOME entier
    refused([{ host: join(skillsDir, 'xlsx'), guest: '/dossiers/S', writable: false }]);
  });
});

describe('LimaSandbox.setWorkspace avec des dossiers rattachés', () => {
  it('monte les dossiers, les publie dans l’état et convertit leurs chemins', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.setWorkspace(workspace, folders());
    expect(fake.verbs()).toContain('stop');
    expect(fake.verbs()).toContain('start');
    expect(fake.state.mounts).toContainEqual({
      location: archives,
      mountPoint: '/dossiers/Archives',
      writable: false,
    });
    expect(sandbox.status().folders).toEqual(folders());
    expect(sandbox.toGuestPath(join(compta, 'bilan', '2026.csv'))).toBe(
      '/dossiers/Compta/bilan/2026.csv',
    );
    expect(sandbox.toGuestPath(archives)).toBe('/dossiers/Archives');
    expect(sandbox.toHostPath('/dossiers/Archives/vieux.txt')).toBe(join(archives, 'vieux.txt'));
    expect(sandbox.toGuestPath(join(workspace, 'a.md'))).toBe('/workspace/a.md');
  });

  it('ne redémarre pas pour les mêmes dossiers, même dans un autre ordre', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.setWorkspace(workspace, folders());
    fake.calls.length = 0;
    await sandbox.setWorkspace(workspace, [...folders()].reverse());
    expect(fake.verbs()).toEqual([]);
  });

  it('redémarre quand un accès change ou quand on revient à un seul dossier', async () => {
    const { fake, sandbox } = await readySandbox();
    await sandbox.setWorkspace(workspace, folders());
    fake.calls.length = 0;
    await sandbox.setWorkspace(workspace, [
      { host: compta, guest: '/dossiers/Compta', writable: true },
      { host: archives, guest: '/dossiers/Archives', writable: true },
    ]);
    expect(fake.verbs()).toContain('start');
    fake.calls.length = 0;
    await sandbox.setWorkspace(workspace);
    expect(fake.verbs()).toContain('start');
    expect(sandbox.status().folders).toBeUndefined();
    expect(sandbox.toGuestPath(join(compta, 'x'))).toBeNull();
  });

  it('résout les liens symboliques des dossiers rattachés', async () => {
    const link = join(root, 'lien-compta');
    await symlink(compta, link);
    const { fake, sandbox } = await readySandbox();
    await sandbox.setWorkspace(workspace, [
      { host: link, guest: '/dossiers/Compta', writable: true },
    ]);
    expect(fake.state.mounts).toContainEqual({
      location: compta,
      mountPoint: '/dossiers/Compta',
      writable: true,
    });
  });

  it('refuse un dossier absent ou inclus dans le dossier de travail', async () => {
    const { sandbox } = await readySandbox();
    await expectAtelierError(
      sandbox.setWorkspace(workspace, [
        { host: join(root, 'absent'), guest: '/dossiers/A', writable: true },
      ]),
      'tool/failed',
    );
    await mkdir(join(workspace, 'sous'));
    await expectAtelierError(
      sandbox.setWorkspace(workspace, [
        { host: join(workspace, 'sous'), guest: '/dossiers/Sous', writable: true },
      ]),
      'sandbox/invalid_workspace',
    );
  });
});
