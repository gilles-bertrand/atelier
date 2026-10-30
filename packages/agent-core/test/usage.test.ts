/** Usage par étape : cumuls, jauge, event `usage`, débit et relances (ticket #10, ADR-001 §6). */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { InvalidResponseDataError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { RELAUNCH_KINDS, type AgentEvent, type TodoItem, type UsageEvent } from '@atelier/shared';
import {
  Agent,
  createDefaultRegistry,
  tokensPerSecond,
  TurnUsageMeter,
  usageLine,
  type AgentOptions,
  type InjectedKind,
} from '../src/index.js';
import { permissions, scriptedModel, streamOf, usage, withTempDir } from './helpers.js';

const todos = (...statuses: TodoItem['status'][]): { todos: TodoItem[] } => ({
  todos: statuses.map((status, i) => ({ id: String(i + 1), title: `Tâche ${i + 1}`, status })),
});

function agentFor(
  ws: string,
  model: MockLanguageModelV4,
  extra: Partial<AgentOptions> = {},
): Agent {
  return new Agent({
    model,
    registry: createDefaultRegistry(),
    workspace: ws,
    requestPermission: permissions(),
    contextWindow: 32_768,
    ...extra,
  });
}

async function run(agent: Agent, input = 'Fais le travail.') {
  const events: AgentEvent[] = [];
  const result = await agent.runTurn({
    sessionId: 's',
    turnId: 't',
    history: [],
    input,
    emit: (e: AgentEvent) => {
      events.push(e);
    },
  });
  const usageEvents = events.filter((e): e is UsageEvent => e.type === 'usage');
  return { result, events, usageEvents };
}

describe('TokenUsage enrichi', () => {
  it('tour à plusieurs étapes : cumul de l’entrée, sortie, étapes et jauge', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'a.txt'), 'a\n');
      const model = scriptedModel([
        { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }], inputTokens: 1000 },
        { toolCalls: [{ name: 'list_dir', input: {} }], inputTokens: 1200 },
        { text: 'Terminé.', inputTokens: 1500 },
      ]);
      const { result } = await run(agentFor(ws, model));
      expect(result.reason).toBe('stop');
      expect(result.usage).toMatchObject({
        inputTokens: 1500, // sens inchangé : entrée de la dernière étape
        outputTokens: 30, // sens inchangé : sortie cumulée (10 par étape)
        contextWindow: 32_768,
        totalInputTokens: 3700,
        contextTokens: 1510, // entrée + sortie de la dernière étape
        steps: 3,
      });
      expect(result.usage?.relaunches).toBeUndefined();
    });
  });

  it('un event `usage` par étape, cumulé, avant `done`', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'list_dir', input: {} }], inputTokens: 200 },
        { text: 'Fini.', inputTokens: 300 },
      ]);
      const { events, usageEvents } = await run(agentFor(ws, model));
      expect(usageEvents).toHaveLength(2);
      expect(usageEvents.map((e) => e.usage.steps)).toEqual([1, 2]);
      expect(usageEvents.map((e) => e.usage.totalInputTokens)).toEqual([200, 500]);
      expect(usageEvents.map((e) => e.usage.contextTokens)).toEqual([210, 310]);
      expect(usageEvents[0]).toMatchObject({ sessionId: 's', turnId: 't' });
      const types = events.map((e) => e.type);
      expect(types.lastIndexOf('usage')).toBeLessThan(types.indexOf('done'));
    });
  });

  it('`relaunches` compte les continuations', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'todo_write', input: todos('in_progress', 'pending') }] },
        { text: 'Je m’en occupe.' },
        { toolCalls: [{ name: 'todo_write', input: todos('completed', 'completed') }] },
        { text: 'Tout est fait.' },
      ]);
      const { result } = await run(agentFor(ws, model));
      expect(result.reason).toBe('stop');
      expect(result.usage?.relaunches).toEqual({ continuation: 1 });
      expect(result.usage?.steps).toBe(4);
    });
  });

  it('`relaunches` compte le pas vide, y compris quand le tour finit en erreur', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'notes.txt'), 'x\n');
      const read = { toolCalls: [{ name: 'read_file', input: { path: 'notes.txt' } }] };
      const ok = await run(agentFor(ws, scriptedModel([read, {}, { text: 'Résumé.' }])));
      expect(ok.result.usage?.relaunches).toEqual({ empty_final: 1 });

      const ko = await run(agentFor(ws, scriptedModel([read, {}, { text: ' ' }])));
      expect(ko.result.reason).toBe('error');
      expect(ko.result.usage).toMatchObject({ steps: 3, relaunches: { empty_final: 1 } });
    });
  });

  it('usage complet dans TurnResult sur une erreur de stream (pas de `done`)', async () => {
    await withTempDir(async (ws) => {
      const failing = (): {
        stream: ReadableStream<LanguageModelV4StreamPart>;
      } => ({
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Début' },
          { type: 'text-end', id: 't' },
          {
            type: 'error',
            error: new InvalidResponseDataError({
              data: undefined,
              message: 'Response stream ended without a finish reason.',
            }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'error', raw: undefined },
            usage: usage(400, 5),
          },
        ]),
      });
      // Coupé deux fois : une relance (stream_cut), puis l'erreur finale.
      const model = new MockLanguageModelV4({ doStream: [failing(), failing()] });
      const { result, events } = await run(agentFor(ws, model));
      expect(result.reason).toBe('error');
      expect(events.some((e) => e.type === 'done')).toBe(false);
      expect(result.usage).toMatchObject({
        inputTokens: 400,
        outputTokens: 10,
        totalInputTokens: 800,
        contextTokens: 405,
        steps: 2,
        relaunches: { stream_cut: 1 },
      });
      expect(result.usage?.generationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('generationMs : du premier chunk à la fin de chaque étape, horloge injectée', async () => {
    await withTempDir(async (ws) => {
      let t = 0;
      // Chaque lecture de l'horloge avance de 100 ms : 1er chunk puis fin d'étape = 100 ms par étape.
      const clock = (): number => (t += 100);
      const model = new MockLanguageModelV4({
        doStream: [
          streamOf({ toolCalls: [{ name: 'list_dir', input: {} }] }),
          streamOf({ text: 'Un texte en plusieurs morceaux.' }),
        ],
      });
      const { result } = await run(agentFor(ws, model, { clock }));
      expect(result.usage?.generationMs).toBe(200);
      expect(result.usage && tokensPerSecond(result.usage)).toBe(100); // 20 tokens / 0,2 s
    });
  });
});

describe('TurnUsageMeter', () => {
  it('chaque relance de shared est un message injecté par la boucle', () => {
    const kinds: readonly InjectedKind[] = RELAUNCH_KINDS;
    expect(kinds).not.toContain('summary');
    expect(kinds).not.toContain('skill');
  });

  it('ignore le temps avant le premier chunk (prefill) et les chunks suivants', () => {
    let now = 0;
    const meter = new TurnUsageMeter(8192, () => now);
    meter.startStep();
    now = 500; // prefill
    meter.chunk();
    now = 700;
    meter.chunk();
    now = 1500;
    meter.finishStep({ inputTokens: 100, outputTokens: 50 });
    meter.startStep();
    meter.finishStep({ inputTokens: 200, outputTokens: 0 }); // étape sans chunk
    meter.relaunch('verification');
    meter.relaunch('verification');
    expect(meter.snapshot()).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      contextWindow: 8192,
      totalInputTokens: 300,
      contextTokens: 200,
      steps: 2,
      generationMs: 1000,
      relaunches: { verification: 2 },
    });
  });

  it('snapshot avant toute étape : zéros, sans jauge', () => {
    expect(new TurnUsageMeter(4096, () => 0).snapshot()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      contextWindow: 4096,
      totalInputTokens: 0,
      steps: 0,
      generationMs: 0,
    });
  });
});

describe('usageLine (CLI)', () => {
  it('affiche le débit, les étapes et les relances', () => {
    expect(
      usageLine({
        inputTokens: 1500,
        outputTokens: 300,
        contextWindow: 32_768,
        contextTokens: 1800,
        steps: 3,
        generationMs: 10_000,
        relaunches: { continuation: 1 },
      }),
    ).toBe(
      'contexte 1800/32768 · sortie 300 tokens · 30.0 tokens/s · 3 étapes · relances continuation×1',
    );
    expect(usageLine({ inputTokens: 10, outputTokens: 2 })).toBe('contexte 10/? · sortie 2 tokens');
  });
});
