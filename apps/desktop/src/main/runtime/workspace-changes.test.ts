import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diffSnapshots,
  MAX_CARDS_PER_TOOL,
  snapshotWorkspace,
  WorkspaceChangeTracker,
} from './workspace-changes.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atelier-changes-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('snapshotWorkspace', () => {
  it('relève les fichiers, sous-dossiers compris, avec un séparateur /', async () => {
    await mkdir(join(root, 'sous', 'dossier'), { recursive: true });
    await writeFile(join(root, 'a.txt'), 'abc');
    await writeFile(join(root, 'sous', 'dossier', 'b.xlsx'), 'x');
    const snapshot = await snapshotWorkspace(root);
    expect([...(snapshot?.keys() ?? [])].sort()).toEqual(['a.txt', 'sous/dossier/b.xlsx']);
    expect(snapshot?.get('a.txt')?.size).toBe(3);
  });

  it('ignore .atelier, les entrées cachées, node_modules et les liens', async () => {
    await mkdir(join(root, '.atelier', 'uploads'), { recursive: true });
    await writeFile(join(root, '.atelier', 'uploads', 'pj.pdf'), 'x');
    await writeFile(join(root, '.DS_Store'), 'x');
    await mkdir(join(root, 'node_modules', 'lib'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'lib', 'index.js'), 'x');
    await writeFile(join(root, 'vrai.md'), 'x');
    await symlink(join(root, 'vrai.md'), join(root, 'lien.md'));
    const snapshot = await snapshotWorkspace(root);
    expect([...(snapshot?.keys() ?? [])]).toEqual(['vrai.md']);
  });

  it('abandonne au-delà du plafond d’entrées', async () => {
    for (const name of ['1', '2', '3']) await writeFile(join(root, name), 'x');
    expect(await snapshotWorkspace(root, { maxEntries: 2 })).toBeUndefined();
    expect((await snapshotWorkspace(root, { maxEntries: 3 }))?.size).toBe(3);
  });

  it('renvoie undefined pour un dossier absent', async () => {
    expect(await snapshotWorkspace(join(root, 'absent'))).toBeUndefined();
  });
});

describe('diffSnapshots', () => {
  it('distingue créés et modifiés, ignore les suppressions, trie du plus récent', () => {
    const before = new Map([
      ['garde.txt', { size: 1, mtimeMs: 1 }],
      ['change.txt', { size: 1, mtimeMs: 1 }],
      ['supprime.txt', { size: 1, mtimeMs: 1 }],
    ]);
    const after = new Map([
      ['garde.txt', { size: 1, mtimeMs: 1 }],
      ['change.txt', { size: 2, mtimeMs: 5 }],
      ['nouveau.xlsx', { size: 9, mtimeMs: 10 }],
    ]);
    expect(diffSnapshots(before, after)).toEqual([
      { path: 'nouveau.xlsx', action: 'created', size: 9, mtimeMs: 10 },
      { path: 'change.txt', action: 'modified', size: 2, mtimeMs: 5 },
    ]);
  });
});

describe('WorkspaceChangeTracker', () => {
  it('produit une carte par fichier créé ou modifié depuis l’outil précédent', async () => {
    await writeFile(join(root, 'ventes.csv'), 'a');
    const tracker = new WorkspaceChangeTracker(root);
    await tracker.start();

    await writeFile(join(root, 'recap.xlsx'), 'classeur');
    const past = new Date(Date.now() - 60_000);
    await writeFile(join(root, 'ventes.csv'), 'ab');
    await utimes(join(root, 'ventes.csv'), past, past);
    const cards = await tracker.afterTool({
      type: 'command',
      command: 'python',
      exitCode: 0,
      output: '',
    });
    expect(cards).toEqual([
      { path: 'recap.xlsx', absolutePath: join(root, 'recap.xlsx'), size: 8, action: 'created' },
      { path: 'ventes.csv', absolutePath: join(root, 'ventes.csv'), size: 2, action: 'modified' },
    ]);

    // Rien de neuf depuis : aucune carte.
    expect(await tracker.afterTool(undefined)).toEqual([]);
  });

  it('ne double pas la carte que l’outil présente lui-même', async () => {
    const tracker = new WorkspaceChangeTracker(root);
    await tracker.start();
    await writeFile(join(root, 'resume.md'), '# Résumé');
    const cards = await tracker.afterTool({
      type: 'file',
      file: { path: 'resume.md', absolutePath: join(root, 'resume.md'), action: 'created' },
    });
    expect(cards).toEqual([]);

    await writeFile(join(root, 'resume.md'), '# Résumé corrigé');
    expect(
      await tracker.afterTool({ type: 'diff', path: 'resume.md', before: 'a', after: 'b' }),
    ).toEqual([]);
  });

  it(`plafonne à ${String(MAX_CARDS_PER_TOOL)} cartes par outil`, async () => {
    const tracker = new WorkspaceChangeTracker(root);
    await tracker.start();
    for (let i = 0; i < MAX_CARDS_PER_TOOL + 5; i += 1) {
      await writeFile(join(root, `f${String(i)}.txt`), 'x');
    }
    expect(await tracker.afterTool(undefined)).toHaveLength(MAX_CARDS_PER_TOOL);
  });

  it('ne produit rien quand la photo de départ a échoué', async () => {
    const tracker = new WorkspaceChangeTracker(root, { maxEntries: 1 });
    await writeFile(join(root, 'a'), 'x');
    await writeFile(join(root, 'b'), 'x');
    await tracker.start();
    await rm(join(root, 'b'));
    await writeFile(join(root, 'c'), 'x');
    expect(await tracker.afterTool(undefined)).toEqual([]);
  });
});
