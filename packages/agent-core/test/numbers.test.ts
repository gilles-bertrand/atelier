/** Montants cités dans la réponse finale (#61). */
import { describe, expect, it } from 'vitest';
import {
  Agent,
  buildSystemPrompt,
  createDefaultRegistry,
  injectedKind,
  numberValues,
  unverifiedAmounts,
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

  it('ignore les petits nombres et les années', () => {
    expect(unverifiedAmounts('6 mois, 3 magasins, 12 % de hausse, en 2026.', sources)).toEqual([]);
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
