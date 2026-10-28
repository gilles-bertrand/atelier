/**
 * Test réel du modèle vision (skippé par défaut) :
 *
 * ATELIER_DOCUMENTS_IT=1 ATELIER_LLM_URL=http://localhost:11434 \
 *   ATELIER_LLM_MODEL=qwen3.5:9b [ATELIER_LLM_TOKEN=…] pnpm --filter @atelier/documents test
 */
import { describe, expect, it } from 'vitest';
import { createLlmModels } from '@atelier/agent-core';
import { createLookAtTool, createReadFileTool, createVisionAnalyzer } from '../src/index.js';
import { contextFor, fakeSandbox, okContent, withWorkspace } from './helpers.js';

const enabled = process.env['ATELIER_DOCUMENTS_IT'] === '1';

describe.skipIf(!enabled)('vision réelle (ATELIER_DOCUMENTS_IT=1)', () => {
  const models = enabled
    ? createLlmModels({
        baseUrl: process.env['ATELIER_LLM_URL'] ?? 'http://localhost:11434',
        model: process.env['ATELIER_LLM_MODEL'] ?? 'qwen3.5:9b',
        token: process.env['ATELIER_LLM_TOKEN'] ?? '',
        thinking: false,
      })
    : undefined;
  const vision = models ? createVisionAnalyzer({ model: models.model }) : undefined;

  it('transcrit le ticket (PNG)', { timeout: 180_000 }, async () => {
    await withWorkspace(['ticket.png'], async (ws) => {
      const out = okContent(
        await createReadFileTool({ vision, cache: false }).execute(
          { path: 'ticket.png' },
          contextFor(ws),
        ),
      );
      console.info(out);
      expect(out).toMatch(/42[,.]00/);
    });
  });

  it('transcrit la page scannée et répond à look_at', { timeout: 300_000 }, async () => {
    await withWorkspace(['scan.pdf'], async (ws) => {
      const sandbox = fakeSandbox(ws);
      const read = okContent(
        await createReadFileTool({ vision, cache: false }).execute(
          { path: 'scan.pdf' },
          contextFor(ws, { sandbox }),
        ),
      );
      console.info(read);
      expect(read).toMatch(/2026-117/);
      const answer = okContent(
        await createLookAtTool({ vision, cache: false }).execute(
          { path: 'scan.pdf', page: 2, question: 'Quel est le total TTC de la facture ?' },
          contextFor(ws, { sandbox }),
        ),
      );
      console.info(answer);
      expect(answer).toMatch(/1[  ]?234[,.]56/);
    });
  });
});
