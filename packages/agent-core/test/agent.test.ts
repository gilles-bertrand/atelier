import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APICallError, wrapLanguageModel, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@atelier/shared';
import {
  Agent,
  AgentSession,
  createDefaultRegistry,
  SUMMARY_PREFIX,
  textToolCallMiddleware,
} from '../src/index.js';
import {
  collect,
  permissions,
  promptText,
  scriptedModel,
  streamOf,
  summaryModel,
  withTempDir,
} from './helpers.js';

const NOW = new Date('2026-10-27T10:00:00Z');

function agentFor(
  ws: string,
  model: Parameters<typeof wrapLanguageModel>[0]['model'] | MockLanguageModelV4,
  extra: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
  return new Agent({
    model,
    registry: createDefaultRegistry(),
    workspace: ws,
    requestPermission: permissions(),
    contextWindow: 32_768,
    now: () => NOW,
    ...extra,
  });
}

function run(
  agent: Agent,
  input: string,
  extra: { history?: ModelMessage[]; lastInputTokens?: number; abortSignal?: AbortSignal } = {},
) {
  const { events, emit } = collect();
  return agent
    .runTurn({ sessionId: 's1', turnId: 't1', history: extra.history ?? [], input, emit, ...extra })
    .then((result) => ({ result, events }));
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

describe('boucle agentique', () => {
  it('enchaîne plusieurs outils puis répond (events typés, historique complet)', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'notes.txt'), 'Réunion lundi\nBudget 12 k€\n');
      const model = scriptedModel([
        {
          toolCalls: [
            {
              name: 'todo_write',
              input: { todos: [{ id: '1', title: 'Synthèse', status: 'in_progress' }] },
            },
            { name: 'read_file', input: { path: 'notes.txt' } },
          ],
        },
        {
          toolCalls: [
            {
              name: 'write_file',
              input: { path: 'synthese.md', content: '# Synthèse\nBudget : 12 k€' },
            },
          ],
        },
        { toolCalls: [{ name: 'present_file', input: { path: 'synthese.md' } }] },
        { text: 'La synthèse est prête dans synthese.md.' },
      ]);
      const agent = agentFor(ws, model);
      const { result, events } = await run(agent, 'Fais une synthèse de notes.txt');

      expect(result.reason).toBe('stop');
      expect(await readFile(path.join(ws, 'synthese.md'), 'utf8')).toContain('12 k€');
      expect(events.every((e) => e.sessionId === 's1' && e.turnId === 't1')).toBe(true);
      expect(types(events).filter((t) => t !== 'text_delta')).toEqual([
        'tool_start',
        'tool_start',
        'tool_result',
        'todo_update',
        'tool_result',
        'tool_start',
        'permission_request',
        'tool_result',
        'tool_start',
        'tool_result',
        'done',
      ]);
      const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('');
      expect(text).toBe('La synthèse est prête dans synthese.md.');
      const read = events.find((e) => e.type === 'tool_result' && e.toolName === 'read_file');
      expect(read).toMatchObject({ ok: true });
      const presented = events.find(
        (e) => e.type === 'tool_result' && e.toolName === 'present_file',
      );
      expect(presented).toMatchObject({ display: { type: 'file', file: { path: 'synthese.md' } } });
      // Le contenu du fichier lu est renvoyé au modèle à l'étape suivante.
      expect(promptText(model, 1)).toContain('Budget 12 k€');
      // Prompt système : dossier, date, sécurité.
      const system = JSON.stringify(model.doStreamCalls[0]?.prompt[0]);
      expect(system).toContain(ws);
      expect(system).toContain('2026-10-27');
      expect(system).toContain('DONNÉE');
      // Historique : user + (assistant, tool) x3 + assistant final.
      expect(result.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
        'tool',
        'assistant',
        'tool',
        'assistant',
      ]);
      expect(result.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 40,
        contextWindow: 32_768,
      });
      const done = events.at(-1);
      expect(done).toMatchObject({ type: 'done', reason: 'stop' });
    });
  });

  it('un refus de permission est renvoyé au modèle, sans exception', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'write_file', input: { path: 'a.txt', content: 'x' } }] },
        { text: "D'accord, je n'écris rien." },
      ]);
      const deny = permissions('deny');
      const { result, events } = await run(
        agentFor(ws, model, { requestPermission: deny }),
        'Écris a.txt',
      );
      expect(result.reason).toBe('stop');
      expect(deny.requests).toHaveLength(1);
      const tr = events.find((e) => e.type === 'tool_result');
      expect(tr).toMatchObject({ ok: false, denied: true, toolName: 'write_file' });
      expect(promptText(model, 1)).toContain("L'utilisateur a refusé");
      await expect(readFile(path.join(ws, 'a.txt'))).rejects.toThrow();
    });
  });

  it('un chemin hors du dossier est refusé et signalé au modèle', async () => {
    await withTempDir(async (root) => {
      const ws = path.join(root, 'ws');
      await mkdir(ws);
      await writeFile(path.join(root, 'secret.txt'), 'mot de passe');
      await symlink(path.join(root, 'secret.txt'), path.join(ws, 'lien.txt'));
      const model = scriptedModel([
        {
          toolCalls: [
            { name: 'read_file', input: { path: '../secret.txt' } },
            { name: 'read_file', input: { path: 'lien.txt' } },
          ],
        },
        { text: 'Accès impossible.' },
      ]);
      const { events } = await run(agentFor(ws, model), 'Lis le secret');
      const results = events.filter((e) => e.type === 'tool_result');
      expect(results).toHaveLength(2);
      for (const r of results) expect(r).toMatchObject({ ok: false });
      expect(promptText(model, 1)).toContain('en dehors du dossier de travail');
      expect(promptText(model, 1)).not.toContain('mot de passe');
    });
  });

  it('edit_file non unique : erreur explicite au modèle, qui corrige', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'f.md'), 'Total : 10\nTotal : 20\n');
      const model = scriptedModel([
        {
          toolCalls: [
            { name: 'edit_file', input: { path: 'f.md', old_str: 'Total', new_str: 'Somme' } },
          ],
        },
        {
          toolCalls: [
            {
              name: 'edit_file',
              input: { path: 'f.md', old_str: 'Total : 20', new_str: 'Somme : 20' },
            },
          ],
        },
        { text: 'Corrigé.' },
      ]);
      const { events } = await run(agentFor(ws, model), 'Renomme le second total');
      const results = events.filter((e) => e.type === 'tool_result');
      expect(results[0]).toMatchObject({ ok: false });
      expect(promptText(model, 1)).toContain('apparaît 2 fois');
      expect(results[1]).toMatchObject({ ok: true });
      expect(await readFile(path.join(ws, 'f.md'), 'utf8')).toBe('Total : 10\nSomme : 20\n');
    });
  });

  it('répare un nom d’outil approximatif et un JSON mal formé', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        {
          toolCalls: [
            { name: 'Write_File', input: null, raw: '{"path": "a.txt", "content": "A",}' },
            {
              name: 'write_file',
              input: null,
              raw: '```json\n{"arguments": {"path": "b.txt", "content": "B"}}\n```',
            },
          ],
        },
        { text: 'Fait.' },
      ]);
      const repairs: unknown[] = [];
      const agent = agentFor(ws, model, { log: (m, d) => m === 'repair' && repairs.push(d) });
      const { events } = await run(agent, 'Crée a et b');
      expect(await readFile(path.join(ws, 'a.txt'), 'utf8')).toBe('A');
      expect(await readFile(path.join(ws, 'b.txt'), 'utf8')).toBe('B');
      expect(repairs).toEqual([
        { toolName: 'write_file', kind: 'name' },
        { toolName: 'write_file', kind: 'input' },
      ]);
      expect(events.filter((e) => e.type === 'tool_result').every((e) => e.ok)).toBe(true);
    });
  });

  it('un appel irréparable devient une erreur renvoyée au modèle', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'outil_inconnu', input: {} }] },
        { text: 'Pardon.' },
      ]);
      const { result, events } = await run(agentFor(ws, model), 'Fais quelque chose');
      expect(result.reason).toBe('stop');
      expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
        ok: false,
        toolName: 'outil_inconnu',
      });
      expect(promptText(model, 1)).toMatch(/outil_inconnu/);
    });
  });

  it("repli : un appel d'outil écrit en JSON dans le texte est exécuté", async () => {
    await withTempDir(async (ws) => {
      const inner = scriptedModel([
        {
          text: 'Je crée le fichier.\n<tool_call>\n{"name": "write_file", "arguments": {"path": "c.txt", "content": "C"}}\n</tool_call>',
        },
        { text: '```json\n{"name": "list_dir", "arguments": {}}\n```' },
        { text: 'Terminé.' },
      ]);
      const model = wrapLanguageModel({
        model: inner,
        middleware: textToolCallMiddleware(() => 'call_txt'),
      });
      const { result, events } = await run(agentFor(ws, model), 'Crée c.txt');
      expect(await readFile(path.join(ws, 'c.txt'), 'utf8')).toBe('C');
      const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('');
      expect(text).toBe('Je crée le fichier.\nTerminé.');
      expect(events.filter((e) => e.type === 'tool_start').map((e) => e.toolName)).toEqual([
        'write_file',
        'list_dir',
      ]);
      expect(result.reason).toBe('stop');
    });
  });

  it('mode thinking : raisonnement émis à part et jamais réinjecté', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { reasoning: 'Je dois lister le dossier.', toolCalls: [{ name: 'list_dir', input: {} }] },
        { reasoning: 'Rien à faire.', text: 'Le dossier est vide.' },
        { text: 'Toujours vide.' },
      ]);
      const agent = agentFor(ws, model);
      const session = new AgentSession(agent, 's1');
      const { events, emit } = collect();
      await session.send('Que contient le dossier ?', emit);
      const reasoning = events.flatMap((e) => (e.type === 'reasoning_delta' ? [e.delta] : []));
      expect(reasoning).toEqual(['Je dois lister le dossier.', 'Rien à faire.']);
      // Ni dans la 2e étape du même tour, ni dans l'historique du tour suivant.
      expect(promptText(model, 1)).not.toContain('Je dois lister');
      expect(JSON.stringify(session.history)).not.toContain('Rien à faire');
      await session.send('Et maintenant ?', emit);
      expect(promptText(model, 2)).not.toContain('Je dois lister');
      expect(promptText(model, 2)).toContain('Le dossier est vide.');
    });
  });

  it('compaction avant le tour quand inputTokens dépasse 75 % du contexte', async () => {
    await withTempDir(async (ws) => {
      const history: ModelMessage[] = [];
      for (let i = 0; i < 6; i++) {
        history.push(
          { role: 'user', content: `question ${i}` },
          { role: 'assistant', content: [{ type: 'text', text: `réponse ${i}` }] },
        );
      }
      const model = scriptedModel([{ text: 'OK.' }]);
      const fast = summaryModel("L'utilisateur a posé 6 questions.");
      const agent = agentFor(ws, model, {
        fastModel: fast,
        contextWindow: 1000,
        keepRecentOnCompaction: 4,
      });

      // Sous le seuil : rien.
      const below = await run(agent, 'suite', { history, lastInputTokens: 700 });
      expect(below.events.some((e) => e.type === 'compaction')).toBe(false);
      expect(fast.doGenerateCalls).toHaveLength(0);

      const model2 = scriptedModel([{ text: 'OK.' }]);
      const agent2 = agentFor(ws, model2, {
        fastModel: fast,
        contextWindow: 1000,
        keepRecentOnCompaction: 4,
      });
      const { result, events } = await run(agent2, 'suite', { history, lastInputTokens: 800 });
      const compaction = events.find((e) => e.type === 'compaction');
      expect(compaction).toMatchObject({ replacedMessages: 9 });
      expect(JSON.stringify(fast.doGenerateCalls[0]?.prompt)).toContain('question 0');
      const sent = promptText(model2, 0);
      expect(sent).toContain(SUMMARY_PREFIX);
      expect(sent).not.toContain('question 0');
      expect(sent).toContain('question 5');
      expect(result.messages[0]).toMatchObject({ role: 'user' });
      expect(JSON.stringify(result.messages[0])).toContain('6 questions');
    });
  });

  it('compaction en cours de tour (usage de la dernière étape)', async () => {
    await withTempDir(async (ws) => {
      const history: ModelMessage[] = [
        { role: 'user', content: 'ancienne demande' },
        { role: 'assistant', content: [{ type: 'text', text: 'ancienne réponse' }] },
      ];
      const model = scriptedModel([
        { toolCalls: [{ name: 'list_dir', input: {} }], inputTokens: 900 },
        { text: 'Fini.', inputTokens: 200 },
      ]);
      const fast = summaryModel('Résumé.');
      const agent = agentFor(ws, model, {
        fastModel: fast,
        contextWindow: 1000,
        keepRecentOnCompaction: 2,
      });
      const { result, events } = await run(agent, 'liste', { history });
      expect(events.some((e) => e.type === 'compaction')).toBe(true);
      expect(promptText(model, 1)).not.toContain('ancienne demande');
      expect(promptText(model, 1)).toContain(SUMMARY_PREFIX);
      // L'historique final reflète la compaction et contient la suite du tour.
      const roles = result.messages.map((m) => m.role);
      expect(JSON.stringify(result.messages)).not.toContain('ancienne demande');
      expect(roles.at(-1)).toBe('assistant');
      expect(JSON.stringify(result.messages)).toContain('Fini.');
    });
  });

  it('annulation : done aborted', async () => {
    await withTempDir(async (ws) => {
      const controller = new AbortController();
      const model = new MockLanguageModelV4({
        doStream: (options) => {
          controller.abort();
          if (options.abortSignal?.aborted) {
            return Promise.reject(new DOMException('aborted', 'AbortError'));
          }
          return Promise.resolve(streamOf({ text: 'x' }));
        },
      });
      const { result, events } = await run(agentFor(ws, model), 'stop', {
        abortSignal: controller.signal,
      });
      expect(result.reason).toBe('aborted');
      expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'aborted' });
    });
  });

  it('erreur serveur : event error typé (401 → llm/unauthorized)', async () => {
    await withTempDir(async (ws) => {
      const model = new MockLanguageModelV4({
        doStream: () =>
          Promise.reject(
            new APICallError({
              message: 'Unauthorized',
              url: 'https://llm.example.com/v1/chat/completions',
              requestBodyValues: {},
              statusCode: 401,
            }),
          ),
      });
      const { result, events } = await run(
        agentFor(ws, model, { serverUrl: 'https://llm.example.com' }),
        'salut',
      );
      expect(result.reason).toBe('error');
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'llm/unauthorized' } });
    });
  });

  it('max_steps : la boucle s’arrête à la limite', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel(
        Array.from({ length: 3 }, () => ({ toolCalls: [{ name: 'list_dir', input: {} }] })),
      );
      const { result } = await run(agentFor(ws, model, { maxSteps: 3 }), 'boucle');
      expect(result.reason).toBe('max_steps');
      expect(model.doStreamCalls).toHaveLength(3);
    });
  });
});
