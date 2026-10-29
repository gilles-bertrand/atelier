import { defineConfig } from '@playwright/test';

const real = process.env['ATELIER_E2E_MODE'] === 'real';

/**
 * E2e d'Atelier (Electron). Mode mock par défaut (CI) ; `ATELIER_E2E_MODE=real`
 * pour Ollama + VM Lima en local. Voir qa/README.md.
 */
export default defineConfig({
  testDir: './e2e',
  // Une seule app à la fois : en mode réel, une seule VM et un seul modèle.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: real ? 30 * 60_000 : 90_000,
  expect: { timeout: real ? 60_000 : 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
