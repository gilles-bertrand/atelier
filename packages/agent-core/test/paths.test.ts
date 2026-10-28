import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtelierError } from '@atelier/shared';
import { resolveWorkspacePath, tryResolveWorkspacePath } from '../src/paths.js';
import { withTempDir } from './helpers.js';

async function rejectsOutside(workspace: string, input: string): Promise<void> {
  await expect(resolveWorkspacePath(workspace, input)).rejects.toMatchObject({
    code: 'tool/path_outside_workspace',
  });
}

describe('resolveWorkspacePath', () => {
  it('résout un chemin relatif existant ou à créer', async () => {
    await withTempDir(async (root) => {
      const ws = path.join(root, 'ws');
      await mkdir(ws);
      await writeFile(path.join(ws, 'a.txt'), 'x');
      const existing = await resolveWorkspacePath(ws, 'a.txt');
      expect(existing.exists).toBe(true);
      expect(existing.relativePath).toBe('a.txt');
      const created = await resolveWorkspacePath(ws, 'sous/dossier/b.md');
      expect(created.exists).toBe(false);
      expect(created.relativePath).toBe('sous/dossier/b.md');
      expect((await resolveWorkspacePath(ws, '.')).relativePath).toBe('.');
    });
  });

  it('accepte un chemin absolu dans le dossier (même si le dossier passe par un symlink, cf. /var sur macOS)', async () => {
    await withTempDir(async (root) => {
      const real = path.join(root, 'real');
      await mkdir(real);
      await symlink(real, path.join(root, 'alias'));
      const ws = path.join(root, 'alias');
      const r = await resolveWorkspacePath(ws, path.join(ws, 'f.txt'));
      expect(r.relativePath).toBe('f.txt');
    });
  });

  it('refuse ../, les chemins absolus extérieurs et les chemins vides', async () => {
    await withTempDir(async (root) => {
      const ws = path.join(root, 'ws');
      await mkdir(ws);
      await rejectsOutside(ws, '../secret.txt');
      await rejectsOutside(ws, 'a/../../secret.txt');
      await rejectsOutside(ws, '/etc/passwd');
      await rejectsOutside(ws, path.join(root, 'ws-sibling', 'x'));
      await expect(resolveWorkspacePath(ws, '  ')).rejects.toBeInstanceOf(AtelierError);
      await expect(resolveWorkspacePath(ws, 'a\0b')).rejects.toMatchObject({
        code: 'tool/invalid_input',
      });
    });
  });

  it('refuse un symlink (fichier ou dossier) qui pointe hors du dossier, y compris pour un fichier à créer dessous', async () => {
    await withTempDir(async (root) => {
      const ws = path.join(root, 'ws');
      const outside = path.join(root, 'outside');
      await mkdir(ws);
      await mkdir(outside);
      await writeFile(path.join(outside, 'secret.txt'), 'top secret');
      await symlink(path.join(outside, 'secret.txt'), path.join(ws, 'lien.txt'));
      await symlink(outside, path.join(ws, 'evasion'));
      await rejectsOutside(ws, 'lien.txt');
      await rejectsOutside(ws, 'evasion/secret.txt');
      await rejectsOutside(ws, 'evasion/nouveau/fichier.txt');
      expect(await tryResolveWorkspacePath(ws, 'evasion')).toBeNull();
    });
  });

  it('accepte un symlink interne au dossier', async () => {
    await withTempDir(async (root) => {
      const ws = path.join(root, 'ws');
      await mkdir(path.join(ws, 'docs'), { recursive: true });
      await symlink(path.join(ws, 'docs'), path.join(ws, 'raccourci'));
      const r = await resolveWorkspacePath(ws, 'raccourci/note.md');
      expect(r.relativePath).toBe('docs/note.md');
    });
  });
});
