/** Flux coupé sans finish_reason (jeton réservé <tool_call> sous Ollama, issue #42). */
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError, InvalidResponseDataError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  buildSystemPrompt,
  createDefaultRegistry,
  injectedKind,
  isStreamCut,
  LOGGED_RESPONSE_BODY_CHARS,
  streamCutReason,
  streamErrorLog,
} from '../src/index.js';
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
      expect(
        result.messages
          .filter((m) => injectedKind(m) === 'stream_cut')
          .map((m) => m.providerOptions),
      ).toEqual([{ atelier: { kind: 'stream_cut' } }]);
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

/** Ce que renvoie @ai-sdk/openai-compatible quand le parseur d'appels d'Ollama échoue (#69). */
function parseFailure(body = '{"error":{"message":"EOF","type":"api_error"}}'): APICallError {
  return new APICallError({
    message: 'EOF',
    url: 'http://ollama/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 500,
    responseBody: body,
    isRetryable: true,
  });
}

/** Modèle dont les réponses sont, dans l'ordre, des erreurs levées ou des flux. */
function modelOf(
  ...steps: (Error | { stream: ReadableStream<LanguageModelV4StreamPart> })[]
): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: () => {
      const step = steps[i++];
      if (step === undefined) throw new Error('appel inattendu');
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(step);
    },
  });
}

describe('500 « tool call parsing failed: EOF » d’Ollama (#69)', () => {
  it('reconnaît le 500 à EOF ou au message du parseur, pas un autre 500', () => {
    expect(streamCutReason(parseFailure())).toBe('tool_call_parse');
    expect(
      streamCutReason(
        new APICallError({
          message: 'Internal Server Error',
          url: 'u',
          requestBodyValues: {},
          statusCode: 500,
          responseBody: 'qwen3.5 tool call parsing failed',
        }),
      ),
    ).toBe('tool_call_parse');
    const other = new APICallError({
      message: 'model runner has unexpectedly stopped',
      url: 'u',
      requestBodyValues: {},
      statusCode: 500,
    });
    expect(streamCutReason(other)).toBeUndefined();
    expect(isStreamCut(other)).toBe(false);
    expect(
      streamCutReason(
        new APICallError({ message: 'EOF', url: 'u', requestBodyValues: {}, statusCode: 502 }),
      ),
    ).toBeUndefined();
  });

  it('relance une fois en demandant un appel complet, découpé si le fichier est long', async () => {
    await withTempDir(async (ws) => {
      const model = modelOf(parseFailure(), streamOf({ text: 'Rapport écrit.' }));
      const { result, events } = await run(agentWith(ws, model));
      expect(result.reason).toBe('stop');
      expect(events.some((e) => e.type === 'error')).toBe(false);
      expect(model.doStreamCalls).toHaveLength(2);
      const relaunch = promptText(model, 1);
      expect(relaunch).toContain("n'a pas pu lire ton dernier appel d'outil");
      expect(relaunch).toContain('edit_file');
      expect(result.messages.filter((m) => injectedKind(m) === 'tool_call_parse')).toHaveLength(1);
    });
  });

  it('deux échecs : erreur non réessayable avec details.reason = tool_call_parse', async () => {
    await withTempDir(async (ws) => {
      const model = modelOf(parseFailure(), parseFailure());
      const { result, events } = await run(agentWith(ws, model));
      expect(result.reason).toBe('error');
      expect(model.doStreamCalls).toHaveLength(2);
      expect(result.error).toMatchObject({
        code: 'llm/bad_response',
        retryable: false,
        details: { reason: 'tool_call_parse' },
      });
      expect(result.error?.message).toContain("appel d'outil");
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    });
  });

  it('chaque nature de coupure a sa propre relance dans le tour', async () => {
    await withTempDir(async (ws) => {
      const model = modelOf(parseFailure(), cutStream('Début'), streamOf({ text: 'Fin.' }));
      const { result } = await run(agentWith(ws, model));
      expect(result.reason).toBe('stop');
      expect(model.doStreamCalls).toHaveLength(3);
    });
  });
});

describe('journal stream-error', () => {
  it('ajoute le statut et le début du corps pour une erreur HTTP', () => {
    const error = new APICallError({
      message: 'EOF',
      url: 'u',
      requestBodyValues: {},
      statusCode: 500,
      responseBody: 'x'.repeat(2_000),
    });
    const log = streamErrorLog(error);
    expect(log).toMatchObject({ message: 'EOF', status: 500 });
    expect(log['responseBody']).toBe(`${'x'.repeat(LOGGED_RESPONSE_BODY_CHARS)}…`);
    expect(streamErrorLog(new Error('autre'))).toEqual({ message: 'autre' });
  });
});
