/** Budget de contexte par étape (issue #40). */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  createDefaultRegistry,
  estimateTokens,
  ToolOutputBudget,
  truncateToTokens,
} from '../src/index.js';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

/** CSV de ventes comparable à demo/fixtures/ventes (~30 ko, ~600 lignes). */
function salesCsv(rows = 600): string {
  const lines = ['date,magasin,produit,quantite,prix_unitaire,montant'];
  for (let i = 0; i < rows; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    lines.push(`2026-03-${day},Liège,Cahier A4,${(i % 9) + 1},3.49,${((i % 9) + 1) * 3.49}`);
  }
  return `${lines.join('\n')}\n`;
}

describe('estimateTokens', () => {
  it('compte les chiffres un par un (CSV) et la prose plus légèrement', () => {
    // Mesures Qwen 3.5 : 5 509 caractères de CSV numéroté = 4 045 tokens.
    const csv = salesCsv(100)
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join('\n');
    expect(estimateTokens(csv)).toBeGreaterThan(csv.length / 1.6);
    const prose = 'La réunion de lundi a fixé les objectifs du trimestre pour les trois magasins.';
    expect(estimateTokens(prose)).toBeLessThan(prose.length / 2.5);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('truncateToTokens', () => {
  it('coupe en fin de ligne et repère le dernier numéro de ligne', () => {
    const text = Array.from(
      { length: 50 },
      (_, i) => `${String(i + 1).padStart(6)}\tligne ${i}`,
    ).join('\n');
    const cut = truncateToTokens(text, 60);
    expect(cut.truncated).toBe(true);
    expect(cut.tokens).toBeLessThanOrEqual(60);
    expect(cut.lastLineNumber).toBeGreaterThan(1);
    expect(cut.text.endsWith(`ligne ${String((cut.lastLineNumber ?? 0) - 1)}`)).toBe(true);
  });

  it('coupe une ligne unique trop longue', () => {
    const cut = truncateToTokens('1'.repeat(10_000), 500);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(500);
    expect(cut.text.length).toBeGreaterThan(400);
  });

  it('laisse intact un texte qui tient', () => {
    expect(truncateToTokens('court', 100)).toEqual({
      text: 'court',
      truncated: false,
      tokens: 2,
      keptLines: 1,
      totalLines: 1,
    });
  });
});

describe('ToolOutputBudget', () => {
  it('borne une sortie à 25 % de la fenêtre et la somme d’une étape à 50 %', () => {
    const budget = new ToolOutputBudget(32_768);
    budget.startStep();
    const csv = salesCsv();
    const sizes = [1, 2, 3].map(() => {
      const fitted = budget.fit('read_file', csv);
      expect(fitted.truncated).toBe(true);
      expect(fitted.content).toContain('[Atelier : sortie de read_file tronquée');
      return estimateTokens(fitted.content);
    });
    expect(sizes[0]).toBeLessThanOrEqual(32_768 * 0.25 + 200);
    expect(budget.usedThisStep).toBeLessThanOrEqual(32_768 * 0.5 + 400);
    // Le troisième appel n'a plus que le reliquat (ou le minimum).
    expect(sizes[2]).toBeLessThan(sizes[0] ?? 0);
    budget.startStep();
    expect(budget.usedThisStep).toBe(0);
  });

  it('réduit le budget quand la fenêtre est déjà remplie, sans descendre sous le plancher', () => {
    const budget = new ToolOutputBudget(10_000);
    budget.startStep(8_500);
    expect(budget.stepLimit).toBe(1_000);
    budget.startStep(2_000);
    expect(budget.stepLimit).toBe(5_000);
    budget.startStep(6_000);
    expect(budget.stepLimit).toBe(3_000);
  });

  it('indique l’offset de reprise pour une sortie numérotée', () => {
    const budget = new ToolOutputBudget(4_000);
    budget.startStep();
    const numbered = salesCsv()
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join('\n');
    const { content } = budget.fit('read_file', numbered);
    expect(content).toMatch(/Suite à partir de la ligne (\d+) \(offset: \1\)/);
    expect(content).toMatch(/\d+ lignes affichées sur 602/);
  });
});

describe('Agent : budget par étape', () => {
  it('trois read_file de CSV dans une étape tiennent dans la fenêtre', async () => {
    await withTempDir(async (ws) => {
      for (const name of ['a', 'b', 'c']) {
        await writeFile(path.join(ws, `${name}.csv`), salesCsv());
      }
      const model = scriptedModel([
        {
          toolCalls: ['a', 'b', 'c'].map((name) => ({
            name: 'read_file',
            input: { path: `${name}.csv` },
          })),
          inputTokens: 3_000,
        },
        { text: 'Lu.', inputTokens: 18_000 },
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
        input: 'Lis les trois CSV',
        emit,
      });
      expect(result.reason).toBe('stop');
      const sent = promptText(model, 1);
      expect(estimateTokens(sent)).toBeLessThan(32_768 * 0.6);
      expect(sent).toContain('tronquée pour tenir dans la fenêtre de contexte');
      const outputs = events.filter((e) => e.type === 'tool_result');
      expect(outputs).toHaveLength(3);
      // Le fichier n'est pas modifié : seule la vue du modèle est bornée.
      expect(await readFile(path.join(ws, 'a.csv'), 'utf8')).toBe(salesCsv());
    });
  });
});
