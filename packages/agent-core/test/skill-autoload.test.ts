/** Skill chargé d'office quand la demande contient un déclencheur (critère 2). */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillInfo } from '@atelier/shared';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  buildSystemPrompt,
  createDefaultRegistry,
  injectedKind,
  matchesTrigger,
  SKILL_AUTOLOAD_MAX_BYTES,
  skillAutoloadMessages,
  triggeredSkills,
} from '../src/index.js';
import type { ModelMessage } from 'ai';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

/** Contenu texte d'un message injecté (toujours une chaîne). */
function contentOf(message: ModelMessage | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

function skillAt(dir: string, extra: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'xlsx',
    description: 'Classeurs Excel',
    path: path.join(dir, 'xlsx', 'SKILL.md'),
    guestPath: '/skills/xlsx/SKILL.md',
    scripts: ['/skills/xlsx/scripts/build-workbook.cjs'],
    triggers: ['excel', 'tableur', 'compte rendu'],
    ...extra,
  };
}

async function writeSkill(dir: string, body: string): Promise<void> {
  await mkdir(path.join(dir, 'xlsx'), { recursive: true });
  await writeFile(path.join(dir, 'xlsx', 'SKILL.md'), body);
}

describe('matchesTrigger', () => {
  it('mot entier, sans tenir compte de la casse, des accents ni des tirets', () => {
    expect(matchesTrigger('Fais-moi un fichier EXCEL par mois', 'excel')).toBe(true);
    expect(matchesTrigger('un tableur récapitulatif', 'tableur')).toBe(true);
    expect(matchesTrigger('Un TABLÉUR', 'tableur')).toBe(true);
    expect(matchesTrigger('Rédige le compte-rendu', 'compte rendu')).toBe(true);
    expect(matchesTrigger('excellent travail', 'excel')).toBe(false);
    expect(matchesTrigger('tableurs', 'tableur')).toBe(false);
    expect(matchesTrigger('note', '')).toBe(false);
  });
});

describe('skillAutoloadMessages', () => {
  it('injecte le SKILL.md avec la consigne et le script, seulement si un déclencheur est présent', async () => {
    await withTempDir(async (dir) => {
      await writeSkill(dir, '# xlsx\nLance build-workbook.cjs.\n');
      const loaded: string[] = [];
      const hit = await skillAutoloadMessages('Fais un Excel récapitulatif', [skillAt(dir)], {
        onLoad: (i) => loaded.push(`${i.skill}:${i.trigger}`),
      });
      expect(hit).toHaveLength(1);
      expect(injectedKind(hit[0] ?? { role: 'user', content: '' })).toBe('skill');
      const text = contentOf(hit[0]);
      expect(text).toContain('La demande correspond au skill xlsx');
      expect(text).toContain('/skills/xlsx/scripts/build-workbook.cjs');
      expect(text).toContain('Lance build-workbook.cjs.');
      expect(loaded).toEqual(['xlsx:excel']);
      expect(await skillAutoloadMessages('Résume ce PDF', [skillAt(dir)])).toEqual([]);
      expect(
        await skillAutoloadMessages('Fais un Excel', [skillAt(dir, { triggers: [] })]),
      ).toEqual([]);
    });
  });

  it('plafonne le SKILL.md et renvoie à read_file pour la suite', async () => {
    await withTempDir(async (dir) => {
      const line = 'é'.repeat(99) + '\n';
      await writeSkill(dir, line.repeat(200));
      const [msg] = await skillAutoloadMessages('excel', [skillAt(dir)]);
      const text = contentOf(msg);
      const body = text.slice(text.indexOf('\n\n') + 2, text.lastIndexOf('\n[…'));
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(SKILL_AUTOLOAD_MAX_BYTES);
      expect(body).not.toContain('�');
      expect(text).toContain('SKILL.md tronqué : lis la suite avec read_file');
    });
  });

  it('un SKILL.md illisible est ignoré sans bloquer', async () => {
    const errors: string[] = [];
    const out = await skillAutoloadMessages('excel', [skillAt('/nulle/part')], {
      onError: (i) => errors.push(i.skill),
    });
    expect(out).toEqual([]);
    expect(errors).toEqual(['xlsx']);
  });
});

describe('Agent : chargement d’office au premier pas', () => {
  it('une seule injection par tour, juste après la demande, avec log skill-autoload', async () => {
    await withTempDir(async (dir) => {
      await writeSkill(dir, '# xlsx\nÉtapes du skill.\n');
      const model = scriptedModel([
        { toolCalls: [{ name: 'list_dir', input: {} }] },
        { text: 'Classeur prêt.' },
      ]);
      const logs: string[] = [];
      const agent = new Agent({
        model,
        registry: createDefaultRegistry(),
        workspace: dir,
        requestPermission: permissions(),
        contextWindow: 32_768,
        skills: () => [skillAt(dir)],
        log: (m) => logs.push(m),
      });
      const { emit } = collect();
      const result = await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Crée un tableur des ventes par mois.',
        emit,
      });
      expect(result.reason).toBe('stop');
      expect(promptText(model, 0)).toContain('Étapes du skill.');
      expect(logs.filter((l) => l === 'skill-autoload')).toHaveLength(1);
      const kinds = result.messages.map((m) => injectedKind(m));
      expect(kinds.filter((k) => k === 'skill')).toHaveLength(1);
      expect(result.messages[0]?.role).toBe('user');
      expect(injectedKind(result.messages[1] ?? { role: 'user', content: '' })).toBe('skill');
    });
  });
});

describe('prompt : scripts nommés', () => {
  it('la ligne du skill nomme ses scripts, et les fichiers intermédiaires vont dans /tmp', () => {
    const prompt = buildSystemPrompt({
      workspace: '/ws',
      skills: [skillAt('/h/skills')],
      toolNames: ['bash'],
      sandboxAvailable: true,
    });
    expect(prompt).toContain(
      'Script à lancer avec bash dans la machine isolée : /skills/xlsx/scripts/build-workbook.cjs',
    );
    expect(prompt).toContain('fichiers intermédiaires');
  });
});

/** Skills d'exemple livrés (packages/skills/examples), déclencheurs lus dans le frontmatter. */
async function exampleSkills(): Promise<SkillInfo[]> {
  const root = path.resolve(import.meta.dirname, '../../skills/examples');
  const skills: SkillInfo[] = [];
  for (const name of await readdir(root)) {
    const text = await readFile(path.join(root, name, 'SKILL.md'), 'utf8');
    const list = /^triggers: \[(.*)\]$/m.exec(text)?.[1] ?? '';
    skills.push({
      name,
      description: name,
      path: path.join(root, name, 'SKILL.md'),
      triggers: list.split(',').map((t) => t.trim().toLowerCase()),
    });
  }
  return skills;
}

describe('anti-régression : demandes des critères d’acceptation', () => {
  it('critère 2 ne déclenche que xlsx ; critère 4 ne déclenche aucun skill', async () => {
    const skills = await exampleSkills();
    expect(skills.map((s) => s.name).sort()).toEqual(['artefact-html', 'rapport-markdown', 'xlsx']);
    const names = (request: string): string[] =>
      triggeredSkills(request, skills).map((t) => t.skill.name);
    expect(
      names(
        'Fais-moi un Excel récapitulatif par mois avec un graphique, puis un résumé en markdown',
      ),
    ).toEqual(['xlsx']);
    expect(
      names('Résume le rapport et fais un tableau des montants de la facture et du ticket'),
    ).toEqual([]);
    expect(names('Rédige un rapport en Markdown sur ces ventes')).toEqual(['rapport-markdown']);
    // Artefacts (ADR-003) : un tableau de bord charge le gabarit, un tableau de montants non.
    expect(names('Mets à jour le tableau de bord des ventes')).toEqual(['artefact-html']);
  });
});
