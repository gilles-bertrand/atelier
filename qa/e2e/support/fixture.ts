/**
 * Fixture Playwright commune : serveur LLM (faux en mode mock, Ollama en mode
 * réel), faux SearXNG en mode mock, et une app Atelier lancée par test.
 */
import { writeFile } from 'node:fs/promises';
import { test as base } from '@playwright/test';
import { IS_REAL, launchAtelier, type AtelierApp } from './app.js';
import {
  startFakeSearxng,
  startMockLlm,
  type MockLlm,
  type MockModel,
  type RecordedRequest,
} from './mock-llm.js';
import { ALL_SCENARIOS, NODE_SOURCE } from './scenarios.js';

export const REAL_LLM_URL = process.env['ATELIER_E2E_LLM_URL'] ?? 'http://localhost:11434';
export const REAL_MODEL = process.env['ATELIER_E2E_MODEL'] ?? 'atelier';

interface Llm {
  url: string;
  model: string;
  /** Requêtes reçues (mode mock seulement). */
  requests: RecordedRequest[];
  /** Faux serveur (mode mock seulement) : état chargé réglable. */
  mock?: MockLlm;
}

interface Fixtures {
  llm: Llm;
  /** Fichiers à copier dans le dossier de travail (à surcharger avec `test.use`). */
  seed: string[];
  /** Modèles du faux serveur (mode mock, défaut : `atelier:latest` seul). */
  mockModels: MockModel[] | undefined;
  /** Modèles en mémoire au démarrage du faux serveur (défaut : le premier). */
  mockLoaded: string[] | undefined;
  /** Modèle par défaut des Réglages (mode mock, défaut `atelier`). */
  defaultModel: string;
  atelier: AtelierApp;
}

export const test = base.extend<Fixtures>({
  seed: [[], { option: true }],
  mockModels: [undefined, { option: true }],
  mockLoaded: [undefined, { option: true }],
  defaultModel: ['atelier', { option: true }],
  llm: async ({ mockModels, mockLoaded, defaultModel }, use) => {
    if (IS_REAL) {
      await use({ url: REAL_LLM_URL, model: REAL_MODEL, requests: [] });
      return;
    }
    const llm = await startMockLlm(ALL_SCENARIOS, {
      ...(mockModels ? { models: mockModels } : {}),
      ...(mockLoaded ? { loaded: mockLoaded } : {}),
    });
    const searxng = await startFakeSearxng([
      {
        title: 'Node.js — Previous Releases',
        url: NODE_SOURCE,
        content: 'Major Node.js versions enter Active LTS status…',
      },
    ]);
    await use({ url: llm.url, model: defaultModel, requests: llm.requests, mock: llm });
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
