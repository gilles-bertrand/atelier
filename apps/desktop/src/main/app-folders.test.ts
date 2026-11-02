import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appFolder,
  defaultMcpConfigPath,
  defaultSkillsDir,
  legacyAppFolder,
  migrateLegacyFolders,
} from './app-folders.js';

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function legacyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'yodai-home-'));
  await mkdir(join(legacyAppFolder(home), 'skills', 'xlsx'), { recursive: true });
  await writeFile(join(legacyAppFolder(home), 'skills', 'xlsx', 'SKILL.md'), '# xlsx');
  await writeFile(join(legacyAppFolder(home), 'mcp.json'), '{"mcpServers":{}}');
  return home;
}

const legacySettings = (home: string) => ({
  skillsDir: join(home, 'Atelier', 'skills'),
  mcpConfigPath: join(home, 'Atelier', 'mcp.json'),
});

describe('dossier de l’app', () => {
  it('vit dans ~/Documents/YodAI', () => {
    expect(appFolder('/Users/a')).toBe('/Users/a/Documents/YodAI');
    expect(defaultSkillsDir('/Users/a')).toBe('/Users/a/Documents/YodAI/skills');
    expect(defaultMcpConfigPath('/Users/a')).toBe('/Users/a/Documents/YodAI/mcp.json');
  });
});

describe('migrateLegacyFolders', () => {
  it('déplace skills et mcp.json de ~/Atelier et supprime l’ancien dossier vide', async () => {
    const home = await legacyHome();
    await writeFile(join(legacyAppFolder(home), '.DS_Store'), '');
    const result = await migrateLegacyFolders(legacySettings(home), home);

    expect(result.patch).toEqual({
      skillsDir: defaultSkillsDir(home),
      mcpConfigPath: defaultMcpConfigPath(home),
    });
    expect(result.moved).toHaveLength(2);
    expect(await readFile(join(defaultSkillsDir(home), 'xlsx', 'SKILL.md'), 'utf8')).toBe('# xlsx');
    expect(await readFile(defaultMcpConfigPath(home), 'utf8')).toBe('{"mcpServers":{}}');
    expect(await exists(legacyAppFolder(home))).toBe(false);
  });

  it('garde ~/Atelier s’il contient autre chose (dossiers de travail, projets)', async () => {
    const home = await legacyHome();
    await mkdir(join(legacyAppFolder(home), 'Projets', 'Ventes'), { recursive: true });
    await migrateLegacyFolders(legacySettings(home), home);
    expect(await readdir(legacyAppFolder(home))).toEqual(['Projets']);
  });

  it('n’écrase rien : si la cible existe, l’ancien chemin reste réglé', async () => {
    const home = await legacyHome();
    await mkdir(defaultSkillsDir(home), { recursive: true });
    const result = await migrateLegacyFolders(legacySettings(home), home);

    expect(result.kept).toEqual([join(home, 'Atelier', 'skills')]);
    expect(result.patch).toEqual({ mcpConfigPath: defaultMcpConfigPath(home) });
    expect(await exists(join(home, 'Atelier', 'skills', 'xlsx', 'SKILL.md'))).toBe(true);
  });

  it('ne touche pas un chemin choisi par l’utilisateur', async () => {
    const home = await legacyHome();
    const custom = { skillsDir: '/Volumes/X/skills', mcpConfigPath: '/Volumes/X/mcp.json' };
    const result = await migrateLegacyFolders(custom, home);
    expect(result).toEqual({ moved: [], kept: [], patch: {} });
    expect(await exists(join(home, 'Atelier', 'skills'))).toBe(true);
  });

  it('ancien chemin réglé mais absent du disque : bascule simplement sur le nouveau', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yodai-home-'));
    const result = await migrateLegacyFolders(legacySettings(home), home);
    expect(result.moved).toEqual([]);
    expect(result.patch).toEqual({
      skillsDir: defaultSkillsDir(home),
      mcpConfigPath: defaultMcpConfigPath(home),
    });
  });
});
