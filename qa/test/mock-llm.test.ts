/**
 * Le faux serveur LLM des e2e doit rester compris par le vrai provider de
 * l'app (AI SDK + openai-compatible) : sinon le mode mock testerait un
 * protocole qui n'existe pas.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { createLlmModels, fetchContextWindow, listModels } from '@atelier/agent-core';
import { locate, startMockLlm, type MockLlm } from '../e2e/support/mock-llm.js';
import { ALL_SCENARIOS, PROMPTS, uploadPath } from '../e2e/support/scenarios.js';

let llm: MockLlm | undefined;
afterEach(async () => {
  await llm?.close();
  llm = undefined;
});

describe('faux serveur LLM', () => {
  it('répond aux routes Ollama lues par l’app (modèles, contexte)', async () => {
    llm = await startMockLlm(ALL_SCENARIOS);
    const { models } = await listModels({ baseUrl: llm.url });
    expect(models.map((m) => m.name)).toContain('atelier:latest');
    const context = await fetchContextWindow({ baseUrl: llm.url, model: 'atelier' });
    expect(context.contextWindow).toBe(32_768);
  });

  it('un appel d’outil scripté arrive comme un vrai tool call via le provider de l’app', async () => {
    llm = await startMockLlm(ALL_SCENARIOS);
    const { model } = createLlmModels({ baseUrl: llm.url, model: 'atelier', thinking: false });
    const result = streamText({
      model,
      prompt: PROMPTS.node,
      tools: {
        web_search: tool({
          inputSchema: z.object({ query: z.string(), max_results: z.number().optional() }),
        }),
      },
    });
    const calls = await result.toolCalls;
    expect(calls.map((c) => c.toolName)).toEqual(['web_search']);
    expect(llm.requests[0]?.scenario).toBe('critère 3 : web');
  });

  it('streame le texte final d’une étape', async () => {
    llm = await startMockLlm([
      {
        name: 't',
        match: () => true,
        steps: [{ text: 'Bonjour, voici un texte assez long pour plusieurs deltas.' }],
      },
    ]);
    const { model } = createLlmModels({ baseUrl: llm.url, model: 'atelier', thinking: false });
    const result = streamText({ model, prompt: 'x' });
    expect(await result.text).toBe('Bonjour, voici un texte assez long pour plusieurs deltas.');
  });
});

describe('locate', () => {
  it('étape = nombre de réponses de l’assistant depuis le dernier vrai message utilisateur', () => {
    const where = locate(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: PROMPTS.excel },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', content: 'ok', tool_call_id: '1' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '[Atelier] relance interne' },
      ],
      ALL_SCENARIOS,
    );
    expect(where.scenario?.name).toBe('critère 2 : excel');
    expect(where.step).toBe(2);
    expect(where.vision).toBe(false);
  });

  it('une image dans le message = requête vision', () => {
    const where = locate(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcris le ticket de caisse' },
            { type: 'image_url', image_url: { url: 'data:' } },
          ],
        },
      ],
      ALL_SCENARIOS,
    );
    expect(where.vision).toBe(true);
    expect(where.scenario?.vision?.(where.question)).toContain('27,50');
  });

  it('uploadPath retrouve le chemin d’une pièce jointe mentionnée', () => {
    const messages = [
      {
        role: 'user',
        content: `${PROMPTS.documents}\n\n[Pièce jointe : .atelier/uploads/facture-scannee.pdf]`,
      },
    ];
    expect(uploadPath(messages, 'facture-scannee.pdf')).toBe(
      '.atelier/uploads/facture-scannee.pdf',
    );
  });
});
