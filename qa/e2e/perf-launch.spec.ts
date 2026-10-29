/**
 * Temps de lancement de l'app (mesure, budget large) : du lancement du process
 * Electron à l'écran utile. Premier lancement = `userData` vierge (onboarding) ;
 * lancement suivant = réglages présents (accueil). Résultats joints au rapport
 * et écrits dans qa/reports/ quand ATELIER_E2E_REPORT=1.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchAtelier, REPO_ROOT } from './support/app.js';

const RUNS = 3;
const BUDGET_MS = 15_000;

async function measure(fresh: boolean, heading: string): Promise<number> {
  const started = performance.now();
  // Serveur injoignable : on mesure l'app seule, sans dépendre du modèle.
  const atelier = await launchAtelier({ llmUrl: 'http://127.0.0.1:9', model: 'atelier', fresh });
  try {
    await expect(atelier.page.getByRole('heading', { name: heading })).toBeVisible({
      timeout: BUDGET_MS,
    });
    return performance.now() - started;
  } finally {
    await atelier.close();
  }
}

// eslint-disable-next-line no-empty-pattern -- Playwright exige la déstructuration.
test('temps de lancement de l’app (premier lancement et suivants)', async ({}, testInfo) => {
  const first: number[] = [];
  const next: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    first.push(await measure(true, 'Bienvenue dans Atelier'));
    next.push(await measure(false, 'Sur quoi travaille-t-on ?'));
  }
  const median = (xs: number[]): number =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;
  const result = {
    date: new Date().toISOString(),
    firstLaunchMs: first.map(Math.round),
    nextLaunchMs: next.map(Math.round),
    firstLaunchMedianMs: Math.round(median(first)),
    nextLaunchMedianMs: Math.round(median(next)),
  };
  console.log(JSON.stringify(result));
  await testInfo.attach('launch.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  if (process.env['ATELIER_E2E_REPORT'] === '1') {
    const dir = join(REPO_ROOT, 'qa', 'reports');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `app-launch-${result.date.slice(0, 10)}.json`),
      JSON.stringify(result, null, 2),
    );
  }
  expect(median(first)).toBeLessThan(BUDGET_MS);
  expect(median(next)).toBeLessThan(BUDGET_MS);
});
