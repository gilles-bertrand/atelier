import { describe, expect, it } from 'vitest';
import { toolIconName } from './tool-icons';
import { siteMark, skillName, toolLabel } from './tool-labels';

describe('toolIconName', () => {
  it.each([
    ['read_file', { path: 'rapport.pdf' }, 'read_file'],
    ['write_file', { path: 'recap.md' }, 'write_file'],
    ['edit_file', {}, 'edit_file'],
    ['list_dir', {}, 'list_dir'],
    ['glob', {}, 'glob'],
    ['grep', {}, 'grep'],
    ['bash', { command: 'python3 graphique.py' }, 'bash'],
    ['web_search', {}, 'web_search'],
    ['web_fetch', {}, 'web_fetch'],
    ['todo_write', {}, 'todo_write'],
    ['look_at', {}, 'look_at'],
    ['present_file', {}, 'present_file'],
  ])('%s', (tool, input, icon) => {
    expect(toolIconName(tool, input)).toBe(icon);
  });

  it('donne l’icône des skills à la lecture d’un SKILL.md', () => {
    expect(toolIconName('read_file', { path: '/opt/skills/xlsx/SKILL.md' })).toBe('skill');
  });

  it('regroupe les connecteurs MCP et tool_search', () => {
    expect(toolIconName('mcp__agenda__create_event', {})).toBe('connector');
    expect(toolIconName('tool_search', {})).toBe('connector');
  });

  it('retombe sur une icône générique pour un outil inconnu, même nommé comme une clé', () => {
    expect(toolIconName('ollama', {})).toBe('other');
    expect(toolIconName('skill', {})).toBe('other');
    expect(toolIconName('constructor', {})).toBe('other');
  });
});

describe('skillName et libellé de lecture d’un skill', () => {
  it('lit le nom du dossier du skill', () => {
    expect(skillName({ path: 'skills/xlsx/SKILL.md' })).toBe('xlsx');
    expect(skillName({ path: 'SKILL.md' })).toBe('');
    expect(skillName({ path: 'notes/skill.md' })).toBeUndefined();
    expect(skillName({ path: 'rapport.md' })).toBeUndefined();
    expect(skillName({})).toBeUndefined();
  });

  it('remplace « Lecture de SKILL.md »', () => {
    expect(toolLabel('read_file', { path: '/opt/skills/rapport-markdown/SKILL.md' })).toBe(
      'Consultation du skill rapport-markdown',
    );
    expect(toolLabel('read_file', { path: 'SKILL.md' })).toBe('Consultation d’un skill');
    expect(toolLabel('read_file', { path: 'data/ventes.csv' })).toBe('Lecture de ventes.csv');
  });
});

describe('siteMark', () => {
  it('prend l’initiale du nom du site, sous-domaine de langue ou www écarté', () => {
    expect(siteMark('https://fr.wikipedia.org/wiki/Liège').initial).toBe('W');
    expect(siteMark('https://statbel.fgov.be/fr').initial).toBe('S');
    expect(siteMark('https://www.lesoir.be/123').initial).toBe('L');
  });

  it('donne une teinte stable, propre au site', () => {
    const lesoir = siteMark('https://www.lesoir.be/a');
    expect(siteMark('https://lesoir.be/b').hue).toBe(lesoir.hue);
    expect(lesoir.hue).toBeGreaterThanOrEqual(0);
    expect(lesoir.hue).toBeLessThan(360);
    expect(siteMark('https://statbel.fgov.be').hue).not.toBe(lesoir.hue);
  });

  it('résiste à une adresse invalide', () => {
    expect(siteMark('pas une url')).toEqual(expect.objectContaining({ initial: 'P' }));
  });
});
