/**
 * Relance d'un tour qui s'arrête (finishReason « stop ») alors que la liste de
 * tâches contient encore des tâches jamais commencées (observé avec
 * qwen3.5:9b sans thinking : « Je l'écris dans resume.md. » puis fin du tour).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TodoItem } from '@atelier/shared';
import {
  Agent,
  continuationPrompt,
  createDefaultRegistry,
  MAX_CONTINUATIONS,
} from '../src/index.js';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

const NOW = new Date('2026-10-28T10:00:00Z');

const todos = (...statuses: TodoItem['status'][]): { todos: TodoItem[] } => ({
  todos: statuses.map((status, i) => ({ id: String(i + 1), title: `Tâche ${i + 1}`, status })),
});

function agentFor(ws: string, model: ReturnType<typeof scriptedModel>): Agent {
  return new Agent({
    model,
    registry: createDefaultRegistry(),
    workspace: ws,
    requestPermission: permissions(),
    contextWindow: 32_768,
    now: () => NOW,
  });
}

async function run(agent: Agent) {
  const { events, emit } = collect();
  const result = await agent.runTurn({
    sessionId: 's1',
    turnId: 't1',
    history: [],
    input: 'Lis ventes.csv, écris resume.md puis moyenne.md.',
    emit,
  });
  return { result, events };
}

describe('relance des tâches ouvertes', () => {
  it('« je l’écris » puis stop avec des tâches pending → relancé, le travail est fait', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'ventes.csv'), 'mois,montant\njanvier,10\n');
      const model = scriptedModel([
        {
          toolCalls: [
            { name: 'todo_write', input: todos('in_progress', 'pending', 'pending') },
            { name: 'read_file', input: { path: 'ventes.csv' } },
          ],
        },
        {
          toolCalls: [{ name: 'todo_write', input: todos('completed', 'in_progress', 'pending') }],
        },
        { text: 'Total : 10 €. Je l’écris dans resume.md.' },
        // Relance
        {
          toolCalls: [
            { name: 'write_file', input: { path: 'resume.md', content: 'Total : 10 €' } },
            { name: 'write_file', input: { path: 'moyenne.md', content: 'Moyenne : 10 €' } },
            { name: 'todo_write', input: todos('completed', 'completed', 'completed') },
          ],
        },
        { text: 'C’est fait.' },
      ]);
      const { result, events } = await run(agentFor(ws, model));

      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(5);
      expect(await readFile(path.join(ws, 'moyenne.md'), 'utf8')).toBe('Moyenne : 10 €');
      expect(promptText(model, 3)).toContain('[Atelier] Ta réponse s');
      expect(promptText(model, 3)).toContain('Tâche 3 (pending)');
      // Un seul `done`, à la toute fin ; tous les events portent le même tour.
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('done');
      expect(events.every((e) => e.turnId === 't1')).toBe(true);
      // La relance reste dans l'historique modèle, entre les deux réponses.
      const users = result.messages.filter((m) => m.role === 'user');
      expect(users).toHaveLength(2);
      expect(JSON.stringify(users[1])).toContain('[Atelier]');
      expect(result.messages.at(-1)?.role).toBe('assistant');
    });
  });

  it('pas de relance si le modèle pose une question', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'todo_write', input: todos('in_progress', 'pending') }] },
        { text: 'Quel trimestre veux-tu analyser ?' },
      ]);
      const { result } = await run(agentFor(ws, model));
      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(2);
    });
  });

  it('pas de relance si seule une tâche in_progress reste (oubli de cocher)', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'todo_write', input: todos('completed', 'in_progress') }] },
        { text: 'Le rapport est prêt.' },
      ]);
      await run(agentFor(ws, model));
      expect(model.doStreamCalls).toHaveLength(2);
    });
  });

  it(`au plus ${String(MAX_CONTINUATIONS)} relances par tour`, async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'todo_write', input: todos('in_progress', 'pending') }] },
        { text: 'Je m’en occupe.' },
        { text: 'Je m’en occupe.' },
        { text: 'Je m’en occupe.' },
        { text: 'jamais appelé' },
      ]);
      const { result, events } = await run(agentFor(ws, model));
      expect(model.doStreamCalls).toHaveLength(2 + MAX_CONTINUATIONS);
      expect(result.reason).toBe('stop');
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    });
  });

  it('sans todo_write dans le tour : aucune relance', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{ text: 'Bonjour !' }, { text: 'jamais appelé' }]);
      await run(agentFor(ws, model));
      expect(model.doStreamCalls).toHaveLength(1);
    });
  });

  it('continuationPrompt liste les tâches ouvertes', () => {
    expect(continuationPrompt(todos('in_progress', 'pending').todos)).toContain(
      '- Tâche 1 (in_progress)\n- Tâche 2 (pending)',
    );
  });
});
