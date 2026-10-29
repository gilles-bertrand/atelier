/** Dernier pas vide : ni texte ni appel d'outil, finish « stop », après des outils (#73). */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent, createDefaultRegistry, injectedKind } from '../src/index.js';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

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
    input: 'Lis notes.txt et résume-le.',
    emit,
  });
  return { result, events };
}

const readStep = { toolCalls: [{ name: 'read_file', input: { path: 'notes.txt' } }] };

describe('dernier pas vide (#73)', () => {
  it('relance une fois, puis le tour se termine normalement', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'notes.txt'), 'Réunion du 3 mars.\n');
      const model = scriptedModel([readStep, {}, { text: 'Résumé : réunion du 3 mars.' }]);
      const logs: string[] = [];
      const { result, events } = await run(agentFor(ws, model, logs));
      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(3);
      expect(promptText(model, 2)).toContain('Ta dernière réponse est vide');
      expect(logs).toContain('empty-final');
      expect(result.messages.filter((m) => injectedKind(m) === 'empty_final')).toHaveLength(1);
      // Pas de message assistant vide renvoyé au modèle.
      const sent = model.doStreamCalls[2]?.prompt ?? [];
      expect(sent.filter((m) => m.role === 'assistant' && m.content.length === 0)).toHaveLength(0);
      expect(events.some((e) => e.type === 'error')).toBe(false);
    });
  });

  it('encore vide après la relance : erreur claire, au vouvoiement, non réessayable', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'notes.txt'), 'x\n');
      const model = scriptedModel([readStep, {}, { text: '  ' }]);
      const { result, events } = await run(agentFor(ws, model));
      expect(result.reason).toBe('error');
      expect(model.doStreamCalls).toHaveLength(3);
      expect(result.error).toMatchObject({
        code: 'llm/bad_response',
        retryable: false,
        details: { reason: 'empty_final' },
      });
      expect(result.error?.message).toContain('relancez');
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
      expect(events.some((e) => e.type === 'done')).toBe(false);
    });
  });

  it('sans outil dans le tour, une réponse vide n’est pas relancée', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{}]);
      const { result } = await run(agentFor(ws, model));
      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(1);
    });
  });
});
