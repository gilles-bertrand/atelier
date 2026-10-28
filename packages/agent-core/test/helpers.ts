/** Aides de test : modèle mocké (AI SDK v7, MockLanguageModelV4) et dossiers temporaires. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import type {
  AgentEvent,
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from '@atelier/shared';

export function usage(input = 100, output = 10): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

export interface MockStep {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; input: unknown; id?: string; raw?: string }[];
  inputTokens?: number;
  finish?: 'stop' | 'length' | 'tool-calls';
}

let callCounter = 0;

export function streamOf(step: MockStep): LanguageModelV4StreamResult {
  const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (step.reasoning !== undefined) {
    parts.push(
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: step.reasoning },
      { type: 'reasoning-end', id: 'r' },
    );
  }
  if (step.text !== undefined) {
    // Découpe en plusieurs deltas pour exercer le streaming.
    parts.push({ type: 'text-start', id: 't' });
    const chunks = step.text.match(/[\s\S]{1,7}/g) ?? [];
    for (const delta of chunks) parts.push({ type: 'text-delta', id: 't', delta });
    parts.push({ type: 'text-end', id: 't' });
  }
  for (const call of step.toolCalls ?? []) {
    parts.push({
      type: 'tool-call',
      toolCallId: call.id ?? `call_${++callCounter}`,
      toolName: call.name,
      input: call.raw ?? JSON.stringify(call.input),
    });
  }
  const finish = step.finish ?? (step.toolCalls?.length ? 'tool-calls' : 'stop');
  parts.push({
    type: 'finish',
    finishReason: { unified: finish, raw: finish },
    usage: usage(step.inputTokens ?? 100, 10),
  });
  return { stream: convertArrayToReadableStream(parts) };
}

/** Modèle mocké qui joue une étape scriptée par appel. */
export function scriptedModel(steps: MockStep[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: steps.map(streamOf) });
}

/** Modèle mocké pour `generateText` (résumés de compaction). */
export function summaryModel(summary: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: summary }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: usage(50, 20),
      warnings: [],
    },
  });
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atelier-core-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Gestionnaire de permissions scripté qui enregistre les demandes. */
export function permissions(decision: PermissionDecision = 'allow_once'): PermissionHandler & {
  requests: PermissionRequest[];
} {
  const requests: PermissionRequest[] = [];
  const handler = (request: PermissionRequest): Promise<PermissionDecision> => {
    requests.push(request);
    return Promise.resolve(decision);
  };
  return Object.assign(handler, { requests });
}

export function collect(): { events: AgentEvent[]; emit: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return {
    events,
    emit: (e) => {
      events.push(e);
    },
  };
}

/** Texte complet envoyé au modèle lors de l'appel n° `index`. */
export function promptText(model: MockLanguageModelV4, index: number): string {
  return JSON.stringify(model.doStreamCalls[index]?.prompt ?? []);
}
