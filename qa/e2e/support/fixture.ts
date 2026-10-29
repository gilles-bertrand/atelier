/**
 * Fixture Playwright commune : serveur LLM (faux en mode mock, Ollama en mode
 * réel), faux SearXNG en mode mock, et une app Atelier lancée par test.
 */
import { writeFile } from 'node:fs/promises';
import { test as base } from '@playwright/test';
import { IS_REAL, launchAtelier, type AtelierApp } from './app.js';
import { startFakeSearxng, startMockLlm, type RecordedRequest } from './mock-llm.js';
import { ALL_SCENARIOS, NODE_SOURCE } from './scenarios.js';

export const REAL_LLM_URL = process.env['ATELIER_E2E_LLM_URL'] ?? 'http://localhost:11434';
export const REAL_MODEL = process.env['ATELIER_E2E_MODEL'] ?? 'atelier';

interface Llm {
  url: string;
  model: string;
  /** Requêtes reçues (mode mock seulement). */
  requests: RecordedRequest[];
}

interface Fixtures {
  llm: Llm;
  /** Fichiers à copier dans le dossier de travail (à surcharger avec `test.use`). */
  seed: string[];
  atelier: AtelierApp;
}

export const test = base.extend<Fixtures>({
  seed: [[], { option: true }],
  // eslint-disable-next-line no-empty-pattern -- Playwright exige la déstructuration.
  llm: async ({}, use) => {
    if (IS_REAL) {
      await use({ url: REAL_LLM_URL, model: REAL_MODEL, requests: [] });
      return;
    }
    const llm = await startMockLlm(ALL_SCENARIOS);
    const searxng = await startFakeSearxng([
      {
        title: 'Node.js — Previous Releases',
        url: NODE_SOURCE,
        content: 'Major Node.js versions enter Active LTS status…',
      },
    ]);
    await use({ url: llm.url, model: 'atelier', requests: llm.requests });
    await searxng?.close();
    await llm.close();
  },
  atelier: async ({ llm, seed }, use, testInfo) => {
    const atelier = await launchAtelier({
      llmUrl: llm.url,
      model: llm.model,
      // Mode réel : réflexion activée (défaut de l'app, plus fiable en arithmétique).
      thinking: IS_REAL,
      seed,
    });
    await use(atelier);
    // En réel, le journal du main est toujours joint : relances (`stream-cut:retry`) et
    // vérifications de la réponse s'y lisent même quand le test passe.
    if (IS_REAL || testInfo.status !== testInfo.expectedStatus) {
      const path = testInfo.outputPath('main.log');
      await writeFile(path, atelier.logs.join(''));
      await testInfo.attach('main.log', { path, contentType: 'text/plain' });
    }
    await atelier.close();
  },
});

export { expect } from '@playwright/test';
