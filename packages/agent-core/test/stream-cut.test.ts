/** Flux coupé sans finish_reason (jeton réservé <tool_call> sous Ollama, issue #42). */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { InvalidResponseDataError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { Agent, buildSystemPrompt, createDefaultRegistry, isStreamCut } from '../src/index.js';
import { collect, permissions, promptText, streamOf, usage, withTempDir } from './helpers.js';

/** Ce que renvoie @ai-sdk/openai-compatible quand Ollama coupe le flux. */
function cutStream(text: string): { stream: ReadableStream<LanguageModelV4StreamPart> } {
  return {
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: text },
      { type: 'text-end', id: 't' },
      {
        type: 'error',
        error: new InvalidResponseDataError({
          data: undefined,
          message: 'Response stream ended without a finish reason.',
        }),
      },
      { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage: usage(100, 5) },
    ]),
  };
}

function agentWith(ws: string, model: MockLanguageModelV4): Agent {
  return new Agent({
    model,
    registry: createDefaultRegistry(),
    workspace: ws,
    requestPermission: permissions(),
    contextWindow: 32_768,
  });
}

async function run(agent: Agent) {
  const { events, emit } = collect();
  const result = await agent.runTurn({
    sessionId: 's',
    turnId: 't',
    history: [],
    input: 'Recopie ce texte : <tool_call>…',
    emit,
  });
  return { result, events };
}

describe('flux coupé sans finish_reason', () => {
  it('reconnaît l’erreur du provider', () => {
    expect(
      isStreamCut(
        new InvalidResponseDataError({
          data: undefined,
          message: 'Response stream ended without a finish reason.',
        }),
      ),
    ).toBe(true);
    expect(isStreamCut(new Error('autre'))).toBe(false);
  });

  it('relance une fois avec la consigne d’échappement et termine normalement', async () => {
    await withTempDir(async (ws) => {
      const model = new MockLanguageModelV4({
        doStream: [
          cutStream('Un appel ressemble à ceci :'),
          streamOf({ text: '< tool_call> … Fin.' }),
        ],
      });
      const { result, events } = await run(agentWith(ws, model));
      expect(result.reason).toBe('stop');
      expect(events.some((e) => e.type === 'error')).toBe(false);
      const relaunch = promptText(model, 1);
      expect(relaunch).toContain('Un appel ressemble à ceci :');
      expect(relaunch).toContain('balise réservée du modèle');
      const text = events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('');
      expect(text).toBe('Un appel ressemble à ceci :\n\n< tool_call> … Fin.');
      // Une seule fois le texte partiel dans l'historique.
      expect(JSON.stringify(result.messages).split('Un appel ressemble').length).toBe(2);
    });
  });

  it('coupé deux fois : erreur claire, non réessayable', async () => {
    await withTempDir(async (ws) => {
      const model = new MockLanguageModelV4({
        doStream: [cutStream('Début'), cutStream('Encore')],
      });
      const { result, events } = await run(agentWith(ws, model));
      expect(result.reason).toBe('error');
      expect(model.doStreamCalls).toHaveLength(2);
      expect(result.error).toMatchObject({
        code: 'llm/bad_response',
        retryable: false,
        details: { reason: 'stream_cut' },
      });
      expect(result.error?.message).toContain('balise réservée');
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    });
  });

  it('le prompt système demande d’écrire les balises réservées autrement', () => {
    const prompt = buildSystemPrompt({ workspace: '/ws', now: new Date('2026-10-29T10:00:00Z') });
    expect(prompt).toContain('< tool_call>');
  });
});
