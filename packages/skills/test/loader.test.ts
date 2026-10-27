import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundledExamplesDir,
  installExampleSkills,
  loadSkills,
  parseSkillFrontmatter,
  skillsPrompt,
  type SkillWarning,
} from '../src/index.js';

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-skills-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function skill(dir: string, content: string): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, 'SKILL.md'), content);
}

describe('parseSkillFrontmatter', () => {
  it('lit name et description et compacte les espaces', () => {
    expect(
      parseSkillFrontmatter(
        '---\nname: xlsx\ndescription: >\n  Créer un\n  classeur\n---\n# Corps',
      ),
    ).toEqual({ name: 'xlsx', description: 'Créer un classeur' });
  });
  it('renvoie undefined si le YAML est invalide', () => {
    expect(parseSkillFrontmatter('---\nname: [oups\n---\n')).toBeUndefined();
  });
});

describe('loadSkills', () => {
  it('scanne <dossier>/*/SKILL.md et trie par nom', async () => {
    await skill('b-skill', '---\nname: zeta\ndescription: Dernier\n---\n');
    await skill('a-skill', '---\nname: alpha\ndescription: Premier\n---\n');
    await mkdir(join(root, 'sans-skill'));
    await writeFile(join(root, 'fichier.md'), '---\nname: x\ndescription: y\n---\n');
    const skills = await loadSkills(root);
    expect(skills).toEqual([
      {
        name: 'alpha',
        description: 'Premier',
        path: join(root, 'a-skill', 'SKILL.md'),
        guestPath: '/skills/a-skill/SKILL.md',
      },
      {
        name: 'zeta',
        description: 'Dernier',
        path: join(root, 'b-skill', 'SKILL.md'),
        guestPath: '/skills/b-skill/SKILL.md',
      },
    ]);
  });

  it('renvoie une liste vide si le dossier est absent', async () => {
    expect(await loadSkills(join(root, 'absent'))).toEqual([]);
  });

  it('ignore les skills invalides et le signale', async () => {
    const warnings: SkillWarning[] = [];
    await skill('sans-description', '---\nname: a\n---\n');
    await skill('yaml-casse', '---\nname: [oups\n---\n');
    await skill('sans-nom', '---\ndescription: Utilise le dossier\n---\n');
    await skill('doublon-1', '---\nname: double\ndescription: un\n---\n');
    await skill('doublon-2', '---\nname: double\ndescription: deux\n---\n');
    await skill('.cache', '---\nname: cache\ndescription: caché\n---\n');
    const skills = await loadSkills(root, { onWarning: (w) => warnings.push(w) });
    expect(skills.map((s) => s.name)).toEqual(['double', 'sans-nom']);
    expect(skills.find((s) => s.name === 'double')?.description).toBe('un');
    expect(warnings).toHaveLength(4);
    expect(warnings.map((w) => w.message).join('\n')).toMatch(/description/);
  });

  it('tronque les descriptions trop longues', async () => {
    await skill('long', `---\nname: long\ndescription: ${'a'.repeat(5000)}\n---\n`);
    const [found] = await loadSkills(root);
    expect(found?.description.length).toBe(1024);
  });

  it('ignore un SKILL.md qui pointe hors du dossier (invisible dans la VM)', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'atelier-outside-')));
    try {
      await writeFile(join(outside, 'SKILL.md'), '---\nname: dehors\ndescription: x\n---\n');
      await mkdir(join(root, 'lien'));
      await symlink(join(outside, 'SKILL.md'), join(root, 'lien', 'SKILL.md'));
      const warnings: SkillWarning[] = [];
      expect(await loadSkills(root, { onWarning: (w) => warnings.push(w) })).toEqual([]);
      expect(warnings[0]?.message).toMatch(/hors du dossier/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('peut omettre le chemin VM', async () => {
    await skill('a', '---\nname: a\ndescription: b\n---\n');
    const [found] = await loadSkills(root, { guestRoot: null });
    expect(found).not.toHaveProperty('guestPath');
  });
});

describe('skillsPrompt', () => {
  it('liste nom, description et chemins', () => {
    const prompt = skillsPrompt([
      {
        name: 'xlsx',
        description: 'Créer un Excel',
        path: '/h/xlsx/SKILL.md',
        guestPath: '/skills/xlsx/SKILL.md',
      },
    ]);
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('- **xlsx** : Créer un Excel');
    expect(prompt).toContain('/h/xlsx/SKILL.md (VM : /skills/xlsx/SKILL.md)');
  });
  it('est vide sans skill', () => {
    expect(skillsPrompt([])).toBe('');
  });
});

describe("skills d'exemple", () => {
  it('se chargent tous les deux', async () => {
    const skills = await loadSkills(bundledExamplesDir());
    expect(skills.map((s) => s.name)).toEqual(['rapport-markdown', 'xlsx']);
    for (const s of skills) expect(s.description.length).toBeGreaterThan(50);
  });

  it("s'installent sans écraser un skill existant", async () => {
    await skill('xlsx', '---\nname: xlsx\ndescription: version modifiée\n---\n');
    const installed = await installExampleSkills(bundledExamplesDir(), root);
    expect(installed).toEqual(['rapport-markdown']);
    const skills = await loadSkills(root);
    expect(skills.find((s) => s.name === 'xlsx')?.description).toBe('version modifiée');
    expect(await readdir(join(root, 'rapport-markdown'))).toContain('modele.md');
    expect(await installExampleSkills(bundledExamplesDir(), root)).toEqual([]);
  });
});
