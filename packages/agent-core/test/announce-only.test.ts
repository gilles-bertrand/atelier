/** Tour arrêté sur une annonce sans action (« je vais… »), #79. */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  announcesAction,
  buildSystemPrompt,
  createDefaultRegistry,
  injectedKind,
} from '../src/index.js';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

describe('announcesAction', () => {
  it.each([
    'Commençons par examiner les autres fichiers et ensuite je vais générer le classeur.',
    'J’ai lu ventes-janvier.csv. Je vais maintenant lire les deux autres fichiers…',
    'Les données sont chargées. Maintenant je calcule les totaux par mois.',
    'Laisse-moi vérifier le contenu du dossier.',
    'Passons à la création du fichier Excel.',
    'Voici les étapes suivantes :',
    'I read the first file. Now I will compute the totals.',
    'Let me check the remaining files.',
    'Ensuite, je génère le résumé.',
  ])('annonce : « %s »', (text) => {
    expect(announcesAction(text)).toBe(true);
  });

  it.each([
    'Voici le récapitulatif : le total est de 89 237,10 €.',
    'J’ai créé ventes.xlsx et resume.md. Ensuite, vous pourrez ouvrir le classeur dans Excel.',
    'Le classeur est prêt : ventes.xlsx contient une feuille par mois.',
    'Je vais bien, merci. Le fichier est prêt.',
    'Voulez-vous que je vais plus loin ?',
    'Voulez-vous que je génère aussi un graphique ?',
    'Done. The workbook is ready.',
    '',
  ])('pas une annonce : « %s »', (text) => {
    expect(announcesAction(text)).toBe(false);
  });
});

function agentFor(ws: string, model: ReturnType<typeof scriptedModel>, logs: string[] = []): Agent {
  return new Agent({
    model,
    registry: createDefaultRegistry(),
    workspace: ws,
    requestPermission: permissions(),
    contextWindow: 32_768,
    log: (message) => logs.push(message),
  });
}

async function run(agent: Agent) {
  const { events, emit } = collect();
  const result = await agent.runTurn({
    sessionId: 's',
    turnId: 't',
    history: [],
    input: 'Lis a.txt puis b.txt et résume.',
    emit,
  });
  return { result, events };
}

const readA = { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] };
const announce = { text: 'J’ai lu a.txt. Ensuite je vais lire b.txt.' };

describe('relance d’une annonce sans action (#79)', () => {
  it('relance une fois, le travail continue', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'a.txt'), 'A\n');
      await writeFile(path.join(ws, 'b.txt'), 'B\n');
      const model = scriptedModel([
        readA,
        announce,
        { toolCalls: [{ name: 'read_file', input: { path: 'b.txt' } }] },
        { text: 'Résumé : A puis B.' },
      ]);
      const logs: string[] = [];
      const { result, events } = await run(agentFor(ws, model, logs));
      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(4);
      expect(promptText(model, 2)).toContain('Tu as annoncé une action sans la faire');
      expect(logs).toContain('announce-only');
      expect(result.messages.filter((m) => injectedKind(m) === 'announce_only')).toHaveLength(1);
      expect(events.some((e) => e.type === 'error')).toBe(false);
    });
  });

  it('budget commun avec le pas vide : une seule relance, puis le texte reste sans erreur', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'a.txt'), 'A\n');
      const model = scriptedModel([readA, announce, { text: 'Je vais lire b.txt.' }]);
      const { result, events } = await run(agentFor(ws, model));
      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(3);
      expect(events.some((e) => e.type === 'error')).toBe(false);

      const empty = scriptedModel([readA, announce, {}]);
      const second = await run(agentFor(ws, empty));
      // Relance déjà consommée par l'annonce : le pas vide finit en erreur sans nouvel appel.
      expect(empty.doStreamCalls).toHaveLength(3);
      expect(second.result.error).toMatchObject({ details: { reason: 'empty_final' } });
    });
  });

  it('sans outil dans le tour, pas de relance', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{ text: 'Je vais vous expliquer.' }]);
      const { result } = await run(agentFor(ws, model));
      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(1);
    });
  });
});

describe('prompt : scripts temporaires et installations (#79)', () => {
  it('scripts dans /tmp de la VM, pas d’installation', () => {
    const prompt = buildSystemPrompt({
      workspace: '/ws',
      toolNames: ['bash'],
      sandboxAvailable: true,
    });
    expect(prompt).toContain('/tmp de la machine isolée');
    expect(prompt).toContain('pip install');
  });
});
