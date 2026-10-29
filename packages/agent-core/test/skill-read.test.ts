/** Lecture des skills hors du dossier de travail, en lecture seule (#60 v2). */
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillInfo, ToolExecutionContext, ToolOutput } from '@atelier/shared';
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  createDefaultRegistry,
  resolveReadablePath,
  skillReadRoots,
} from '../src/index.js';
import { permissions, withTempDir } from './helpers.js';

async function setup(base: string) {
  const ws = path.join(base, 'ws');
  const skillsDir = path.join(base, 'Atelier', 'skills');
  await mkdir(path.join(skillsDir, 'xlsx', 'scripts'), { recursive: true });
  await mkdir(ws, { recursive: true });
  await writeFile(path.join(skillsDir, 'xlsx', 'SKILL.md'), '# xlsx\nLance scripts/build.cjs\n');
  await writeFile(path.join(skillsDir, 'xlsx', 'scripts', 'build.cjs'), '// script\n');
  await writeFile(path.join(base, 'secret.txt'), 'secret\n');
  const skills: SkillInfo[] = [
    {
      name: 'xlsx',
      description: 'Classeurs Excel',
      path: path.join(skillsDir, 'xlsx', 'SKILL.md'),
      guestPath: '/skills/xlsx/SKILL.md',
    },
  ];
  return { ws, skillsDir, skills, roots: skillReadRoots(skills) };
}

function context(workspace: string): ToolExecutionContext {
  return {
    sessionId: 's',
    toolCallId: 'c',
    workspace,
    abortSignal: new AbortController().signal,
    requestPermission: permissions(),
  };
}

async function call(
  registry: ReturnType<typeof createDefaultRegistry>,
  name: string,
  input: unknown,
  ws: string,
): Promise<ToolOutput> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`outil ${name} absent`);
  return await tool.execute(input, context(ws));
}

describe('racine des skills en lecture seule', () => {
  it('le chemin annoncé dans le prompt est lisible par read_file (exigence QA)', async () => {
    await withTempDir(async (base) => {
      const { ws, skills, roots } = await setup(base);
      const prompt = buildSystemPrompt({ workspace: ws, skills });
      const announced = /SKILL\.md \(à lire avec read_file\) : (.+)$/m.exec(prompt)?.[1];
      expect(announced).toBe(skills[0]?.path);
      const registry = createDefaultRegistry([], { readRoots: () => roots });
      const out = await call(registry, 'read_file', { path: announced }, ws);
      expect(out.ok).toBe(true);
      expect(out.content).toContain('Lance scripts/build.cjs');
    });
  });

  it('accepte le chemin VM et le relatif « skills/<nom>/… » absent du dossier de travail', async () => {
    await withTempDir(async (base) => {
      const { ws, skillsDir, roots } = await setup(base);
      for (const input of ['/skills/xlsx/SKILL.md', 'skills/xlsx/SKILL.md']) {
        const r = await resolveReadablePath(ws, input, roots);
        expect(r.readOnly).toBe(true);
        expect(r.exists).toBe(true);
        expect(r.absolutePath.endsWith(path.join('skills', 'xlsx', 'SKILL.md'))).toBe(true);
      }
      const registry = createDefaultRegistry([], { readRoots: () => roots });
      const listing = await call(registry, 'list_dir', { path: path.join(skillsDir, 'xlsx') }, ws);
      expect(listing.content).toContain('scripts/');
      expect(listing.content).toContain('SKILL.md');
    });
  });

  it('un fichier du dossier de travail prime sur la racine des skills', async () => {
    await withTempDir(async (base) => {
      const { ws, roots } = await setup(base);
      await mkdir(path.join(ws, 'skills', 'xlsx'), { recursive: true });
      await writeFile(path.join(ws, 'skills', 'xlsx', 'SKILL.md'), 'local\n');
      const r = await resolveReadablePath(ws, 'skills/xlsx/SKILL.md', roots);
      expect(r.readOnly).toBe(false);
      expect(r.relativePath).toBe('skills/xlsx/SKILL.md');
    });
  });

  it('pas d’évasion par .. ni par lien symbolique hors de la racine', async () => {
    await withTempDir(async (base) => {
      const { ws, skillsDir, roots } = await setup(base);
      await symlink(path.join(base, 'secret.txt'), path.join(skillsDir, 'xlsx', 'lien.txt'));
      for (const input of [
        path.join(skillsDir, '..', '..', 'secret.txt'),
        'skills/../../secret.txt',
        '/skills/../secret.txt',
        path.join(skillsDir, 'xlsx', 'lien.txt'),
      ]) {
        await expect(resolveReadablePath(ws, input, roots)).rejects.toMatchObject({
          code: 'tool/path_outside_workspace',
        });
      }
    });
  });

  it('les outils d’écriture restent limités au dossier de travail', async () => {
    await withTempDir(async (base) => {
      const { ws, skills, roots } = await setup(base);
      const registry = createDefaultRegistry([], { readRoots: () => roots });
      const target = skills[0]?.path ?? '';
      const write = await call(registry, 'write_file', { path: target, content: 'x' }, ws);
      expect(write.ok).toBe(false);
      const edit = await call(
        registry,
        'edit_file',
        { path: target, old_str: '# xlsx', new_str: 'x' },
        ws,
      );
      expect(edit.ok).toBe(false);
    });
  });

  it('sans racine de lecture, rien ne change', async () => {
    await withTempDir(async (base) => {
      const { ws, skills } = await setup(base);
      const out = await call(createDefaultRegistry(), 'read_file', { path: skills[0]?.path }, ws);
      expect(out.ok).toBe(false);
    });
  });
});
