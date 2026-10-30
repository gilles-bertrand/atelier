/** Compaction en cours de tour (issue #39) : garder la demande, réduire les vieux résultats d'outils. */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  compactMessages,
  createDefaultRegistry,
  continuationPrompt,
  currentTurnStart,
  estimateMessagesTokens,
  findCompactionSplit,
  PRUNED_PREFIX,
  pruneToolResults,
  SUMMARY_PREFIX,
} from '../src/index.js';
import {
  collect,
  permissions,
  promptText,
  scriptedModel,
  summaryModel,
  withTempDir,
} from './helpers.js';

const DEMANDE = 'Fais-moi un Excel récapitulatif par mois des trois CSV de ventes.';

function readCall(id: string, file: string): ModelMessage['content'][number] {
  return { type: 'tool-call', toolCallId: id, toolName: 'read_file', input: { path: file } };
}

/** Historique de l'issue : 3 read_file de 90 000 caractères puis un list_dir. */
function issueHistory(): ModelMessage[] {
  const csv = '2026-03-01,Liège,Cahier,3,3.49,10.47\n'.repeat(2_400).slice(0, 90_000);
  const files = ['bruxelles.csv', 'liege.csv', 'namur.csv'];
  return [
    { role: 'user', content: DEMANDE },
    {
      role: 'assistant',
      content: files.map((f, i) => readCall(`r${String(i)}`, f)) as never,
    },
    {
      role: 'tool',
      content: files.map((f, i) => ({
        type: 'tool-result' as const,
        toolCallId: `r${String(i)}`,
        toolName: 'read_file',
        output: { type: 'text' as const, value: csv },
      })),
    },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'list_dir', input: {} }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'l1',
          toolName: 'list_dir',
          output: { type: 'text', value: 'bruxelles.csv\nliege.csv\nnamur.csv' },
        },
      ],
    },
  ];
}

describe('currentTurnStart', () => {
  it('ignore les résumés et les relances de l’app', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: `${SUMMARY_PREFIX}\nancien travail` },
      { role: 'user', content: DEMANDE },
      { role: 'assistant', content: [{ type: 'text', text: 'Je commence.' }] },
      { role: 'user', content: continuationPrompt([{ id: 'a', title: 'A', status: 'pending' }]) },
    ];
    expect(currentTurnStart(messages)).toBe(1);
  });
});

describe('findCompactionSplit', () => {
  it('issue #39 : ne coupe jamais après la demande du tour en cours', () => {
    expect(findCompactionSplit(issueHistory(), 6)).toBe(-1);
  });

  it('coupe au plus tard sur la demande du tour (tours précédents résumables)', () => {
    const previous: ModelMessage[] = [];
    for (let i = 0; i < 4; i++) {
      previous.push(
        { role: 'user', content: `question ${String(i)}` },
        { role: 'assistant', content: [{ type: 'text', text: `réponse ${String(i)}` }] },
      );
    }
    const messages = [...previous, ...issueHistory()];
    const split = findCompactionSplit(messages, 2);
    expect(split).toBe(previous.length);
    expect(messages[split]).toMatchObject({ role: 'user', content: DEMANDE });
  });
});

describe('pruneToolResults', () => {
  it('réduit les plus anciens d’abord et protège les résultats de la dernière étape', () => {
    const messages = issueHistory();
    // On ajoute une étape dont les résultats n'ont pas encore été lus.
    const last: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'x',
          toolName: 'read_file',
          output: { type: 'text', value: 'nouveau '.repeat(2_000) },
        },
      ],
    };
    const { messages: out, pruned } = pruneToolResults([...messages, last], 5_000);
    expect(pruned).toBe(3);
    const text = JSON.stringify(out);
    expect(text.split(PRUNED_PREFIX)).toHaveLength(4);
    expect(text).toContain('nouveau nouveau');
    // Les appels sont gardés, la demande aussi.
    expect(out[0]).toEqual(messages[0]);
    expect(out[1]).toEqual(messages[1]);
  });

  it('s’arrête dès que la cible est atteinte', () => {
    const messages = issueHistory();
    const total = estimateMessagesTokens(messages);
    const { pruned } = pruneToolResults(messages, total - 100);
    expect(pruned).toBe(1);
  });

  it('dernière étape d’un tour précédent (déjà lue) : réductible', () => {
    const previous: ModelMessage[] = [
      // Le tour précédent se termine sur les trois read_file, lus puis commentés.
      ...issueHistory().slice(0, 3),
      { role: 'assistant', content: 'Voici le récapitulatif.' },
      { role: 'user', content: 'Merci, et pour avril ?' },
    ];
    const { pruned } = pruneToolResults(previous, 0);
    expect(pruned).toBe(3);
  });
});

describe('compactMessages', () => {
  it('issue #39 : garde la demande et divise au moins par deux la taille, sans résumé', async () => {
    const messages = issueHistory();
    const fast = summaryModel('Résumé.');
    const before = estimateMessagesTokens(messages);
    const result = await compactMessages({
      model: fast,
      messages,
      keepRecent: 6,
      targetTokens: 16_384,
    });
    expect(result.replaced).toBe(0);
    expect(result.pruned).toBe(3);
    expect(fast.doGenerateCalls).toHaveLength(0);
    expect(result.messages[0]).toEqual({ role: 'user', content: DEMANDE });
    expect(JSON.stringify(result.messages).length).toBeLessThan(
      JSON.stringify(messages).length / 2,
    );
    expect(estimateMessagesTokens(result.messages)).toBeLessThan(before / 2);
  });

  it('résume les tours précédents si réduire les résultats ne suffit pas', async () => {
    const previous: ModelMessage[] = [];
    for (let i = 0; i < 4; i++) {
      previous.push(
        { role: 'user', content: `question ${String(i)} ${'détail '.repeat(400)}` },
        { role: 'assistant', content: [{ type: 'text', text: `réponse ${String(i)}` }] },
      );
    }
    const fast = summaryModel('Quatre questions posées.');
    const result = await compactMessages({
      model: fast,
      messages: [...previous, ...issueHistory()],
      keepRecent: 2,
      targetTokens: 500,
    });
    expect(result.replaced).toBe(previous.length);
    expect(result.messages[0]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(result.messages[0])).toContain(SUMMARY_PREFIX);
    expect(result.messages[1]).toEqual({ role: 'user', content: DEMANDE });
  });
});

describe('Agent : compaction en cours de tour', () => {
  it('garde la demande et réduit l’ancien résultat d’outil, sans résumé', async () => {
    await withTempDir(async (ws) => {
      await writeFile(
        path.join(ws, 'ventes.csv'),
        '2026-03-01,Liège,Cahier,3,3.49\n'.repeat(2_000),
      );
      const model = scriptedModel([
        { toolCalls: [{ name: 'read_file', input: { path: 'ventes.csv' } }], inputTokens: 1_000 },
        { toolCalls: [{ name: 'list_dir', input: {} }], inputTokens: 7_000 },
        { text: 'Fini.', inputTokens: 2_000 },
      ]);
      const fast = summaryModel('Résumé.');
      const agent = new Agent({
        model,
        fastModel: fast,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: permissions(),
        contextWindow: 8_000,
      });
      const { events, emit } = collect();
      const result = await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: DEMANDE,
        emit,
      });
      expect(result.reason).toBe('stop');
      expect(events.some((e) => e.type === 'compaction')).toBe(true);
      expect(fast.doGenerateCalls).toHaveLength(0);
      const sent = promptText(model, 2);
      expect(sent).toContain(DEMANDE);
      expect(sent).toContain(PRUNED_PREFIX);
      expect(sent).toContain('read_file');
    });
  });
});
