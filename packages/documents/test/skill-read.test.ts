/** read_file lit le SKILL.md annoncé dans le prompt, hors du dossier de travail (#60 v2). */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkillInfo } from '@atelier/shared';
import { buildSystemPrompt, skillReadRoots } from '@atelier/agent-core';
import { describe, expect, it } from 'vitest';
import { createReadFileTool } from '../src/index.js';
import { contextFor, okContent, withWorkspace } from './helpers.js';

describe('read_file : racine des skills en lecture seule', () => {
  it('lit le chemin annoncé dans le prompt (hôte), le chemin VM et « skills/<nom>/… »', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'atelier-skills-'));
    try {
      const skillsDir = path.join(base, 'skills');
      await mkdir(path.join(skillsDir, 'xlsx'), { recursive: true });
      await writeFile(path.join(skillsDir, 'xlsx', 'SKILL.md'), '# xlsx\nLance le script.\n');
      const skills: SkillInfo[] = [
        {
          name: 'xlsx',
          description: 'Classeurs Excel',
          path: path.join(skillsDir, 'xlsx', 'SKILL.md'),
          guestPath: '/skills/xlsx/SKILL.md',
        },
      ];
      await withWorkspace([], async (ws) => {
        const prompt = buildSystemPrompt({ workspace: ws, skills });
        const announced = /SKILL\.md \(à lire avec read_file\) : (.+)$/m.exec(prompt)?.[1] ?? '';
        const tool = createReadFileTool({ cache: false, readRoots: () => skillReadRoots(skills) });
        for (const input of [announced, '/skills/xlsx/SKILL.md', 'skills/xlsx/SKILL.md']) {
          expect(okContent(await tool.execute({ path: input }, contextFor(ws)))).toContain(
            'Lance le script.',
          );
        }
        // Sans racine de lecture : refusé, comme avant.
        const strict = createReadFileTool({ cache: false });
        const refused = await strict.execute({ path: announced }, contextFor(ws));
        expect(refused).toMatchObject({ ok: false });
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
