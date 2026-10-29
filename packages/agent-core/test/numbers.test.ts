/** Montants cités dans la réponse finale (#61). */
import { describe, expect, it } from 'vitest';
import {
  Agent,
  buildSystemPrompt,
  CORRECTION_PREFIX,
  createDefaultRegistry,
  injectedKind,
  numberValues,
  unverifiedAmounts,
  verificationPrompt,
} from '../src/index.js';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

describe('numberValues', () => {
  it('lit les formats français et anglais', () => {
    expect(numberValues('89 237,10')).toContain(89_237.1);
    expect(numberValues('89 237,10')).toContain(89_237.1);
    expect(numberValues('89,237.10')).toContain(89_237.1);
    expect(numberValues('89237.1')).toContain(89_237.1);
    expect(numberValues('1,234')).toEqual(expect.arrayContaining([1.234, 1234]));
  });

  it('un séparateur n’est de milliers que s’il est suivi d’exactement 3 chiffres', () => {
    expect(numberValues('25,94')).toEqual([25.94]);
    expect(numberValues('25.9')).toEqual([25.9]);
    expect(numberValues('89 237,10')).toEqual([89_237.1]);
    expect(numberValues('1.234.567')).toEqual([1_234_567]);
    expect(numberValues('1.234.567,89')).toEqual([1_234_567.89]);
    expect(numberValues('1,234.5')).toEqual([1_234.5]);
    expect(numberValues('89.237')).toEqual(expect.arrayContaining([89.237, 89_237]));
  });
});

describe('unverifiedAmounts', () => {
  const sources = 'Total général : 89237.1\nBruxelles 31 024,50 ; Liège 29 410,20';

  it('cas de #61 : un total absent des données est signalé', () => {
    expect(unverifiedAmounts('Total global : 59 236,80 € sur 6 mois.', sources)).toEqual([
      '59 236,80',
    ]);
  });

  it('accepte un montant présent, même reformaté ou arrondi', () => {
    expect(unverifiedAmounts('Total : 89 237,10 € (≈ 89 237 €).', sources)).toEqual([]);
    expect(unverifiedAmounts('Bruxelles : 31 024,50 €.', sources)).toEqual([]);
  });

  it('faux positif du critère 2 : « 25,94 » (moyenne) n’est pas un montant à vérifier', () => {
    expect(unverifiedAmounts('Moyenne par vente : 25,94 €.', sources)).toEqual([]);
  });

  it('ignore les petits nombres et les années', () => {
    expect(unverifiedAmounts('6 mois, 3 magasins, 12 % de hausse, en 2026.', sources)).toEqual([]);
  });

  it('un arrondi qui n’en est pas un reste signalé', () => {
    expect(unverifiedAmounts('Total : 89 238 €.', sources)).toEqual(['89 238']);
    expect(unverifiedAmounts('Total : 89 237,2 €.', sources)).toEqual(['89 237,2']);
  });

  it('reste rapide sur la sortie d’un long document', () => {
    const big = Array.from(
      { length: 50_000 },
      (_, i) => `ligne ${i} : ${1000 + i},${i % 100}`,
    ).join('\n');
    const answer = Array.from({ length: 500 }, (_, i) => `${2000 + i},${i % 100} €`).join(' ; ');
    const start = performance.now();
    expect(unverifiedAmounts(answer, big)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe('verificationPrompt', () => {
  it('demande une ligne « Correction : » en tête de la nouvelle réponse (réponse fautive déjà affichée)', () => {
    const prompt = verificationPrompt(['59 236,80']);
    expect(prompt).toContain('« 59 236,80 »');
    expect(prompt).toContain(`« ${CORRECTION_PREFIX} … »`);
    expect(prompt).toContain('déjà vu');
    expect(verificationPrompt(['1 000', '2 000'])).toContain('apparaissent');
  });
});

describe('Agent : vérification des montants de la réponse finale', () => {
  it('relance une fois quand un montant n’est dans aucune donnée du tour', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        {
          toolCalls: [
            {
              name: 'write_file',
              input: { path: 'resume.md', content: '# Ventes\nTotal : 89 237,10 €' },
            },
          ],
        },
        { text: 'Le total est de 59 236,80 €.' },
        { text: 'Le total est de 89 237,10 €, voir resume.md.' },
      ]);
      const agent = new Agent({
        model,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 32_768,
      });
      const { events, emit } = collect();
      const result = await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Résume les ventes',
        emit,
      });
      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(3);
      expect(promptText(model, 2)).toContain('59 236,80');
      expect(result.messages.filter((m) => injectedKind(m) === 'verification')).toHaveLength(1);
      const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('');
      expect(text).toContain('89 237,10 €, voir resume.md');
    });
  });

  it('pas de relance si les montants sont vérifiés, ni sans outil, ni deux fois', async () => {
    await withTempDir(async (ws) => {
      const run = async (steps: Parameters<typeof scriptedModel>[0]) => {
        const model = scriptedModel(steps);
        const agent = new Agent({
          model,
          registry: createDefaultRegistry(),
          workspace: ws,
          requestPermission: permissions(),
          contextWindow: 32_768,
        });
        await agent.runTurn({
          sessionId: 's',
          turnId: 't',
          history: [],
          input: 'x',
          emit: collect().emit,
        });
        return model.doStreamCalls.length;
      };
      // Montant présent dans le fichier écrit.
      expect(
        await run([
          {
            toolCalls: [{ name: 'write_file', input: { path: 'a.md', content: 'Total 12 500 €' } }],
          },
          { text: 'Total : 12 500 €.' },
        ]),
      ).toBe(2);
      // Sans outil : réponse de connaissance générale, pas de vérification.
      expect(await run([{ text: 'Paris compte environ 2 100 000 habitants.' }])).toBe(1);
      // Une seule vérification par tour.
      expect(
        await run([
          { toolCalls: [{ name: 'list_dir', input: {} }] },
          { text: 'Total : 59 236,80 €.' },
          { text: 'Total : 59 236,80 €.' },
        ]),
      ).toBe(3);
    });
  });
});

describe('prompt système', () => {
  it('règles sur les chiffres de la réponse finale et sur les scripts des skills', () => {
    const p = buildSystemPrompt({
      workspace: '/ws',
      skills: [{ name: 'xlsx', description: 'Classeurs Excel', path: '/h/xlsx/SKILL.md' }],
    });
    expect(p).toContain('ne cite un chiffre');
    expect(p).toContain("n'écris pas toi-même de code équivalent");
  });
});
