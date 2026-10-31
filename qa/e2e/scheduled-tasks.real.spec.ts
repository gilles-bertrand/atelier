/**
 * Prompts planifiés (ADR-002, lot L4, ticket #20), scénario réel « rapport
 * hebdo » : une tâche hebdomadaire créée dans le formulaire, « Exécuter
 * maintenant », un vrai modèle (Ollama local) et la VM pour le calcul.
 *
 * Lancement (jamais en CI) :
 *   ATELIER_E2E_MODE=real ATELIER_E2E_MODEL=atelier \
 *     pnpm exec playwright test e2e/scheduled-tasks.real.spec.ts
 * Résultats : docs/QA.md, « Prompts planifiés ».
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { FIXTURES_DIR, IS_REAL, listFiles, sidebar, TURN_TIMEOUT } from './support/app.js';
import { expect, test } from './support/fixture.js';

test.skip(!IS_REAL, 'Mode réel seulement (Ollama local et VM).');
test.use({ seed: [join(FIXTURES_DIR, 'demo-ventes')] });

const PROMPT =
  'Rapport hebdo : calcule le total des ventes (colonne montant) de chaque magasin à partir ' +
  'des fichiers CSV du dossier, puis écris rapport-hebdo.md avec un tableau magasin / total en ' +
  'euros et une phrase de synthèse.';
const REPORT = 'rapport-hebdo.md';
/** Totaux attendus (somme de la colonne montant de chaque CSV). */
const TOTALS: Record<string, number> = { Bruxelles: 40_337.5, Liège: 28_277.1, Namur: 20_622.5 };

/** Montants du rapport, en nombres (`\s` couvre les espaces insécables) (« 40 337,50 », « 40337.50 €»…). */
function amounts(text: string): number[] {
  return [...text.matchAll(/\d[\d\s.,]*\d/g)]
    .map((m) => m[0].replace(/\s/g, ''))
    .map((raw) =>
      /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''),
    )
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

test('rapport hebdo : tâche du lundi 08:00, exécutée maintenant avec Qwen', async ({
  atelier,
}, testInfo) => {
  test.setTimeout(TURN_TIMEOUT + 5 * 60_000);
  const { page, workspace } = atelier;
  const nav = await sidebar(page);
  await nav.getByRole('button', { name: 'Tâches planifiées' }).click();
  await page.getByRole('button', { name: 'Nouvelle tâche' }).click();
  await page.getByRole('textbox', { name: 'Nom' }).fill('Rapport hebdo');
  await page.getByRole('button', { name: 'Choisir…' }).click();
  await page.getByRole('textbox', { name: 'Demande' }).fill(PROMPT);
  await page.getByRole('combobox', { name: 'Fréquence' }).selectOption('weekly');
  await page.getByRole('textbox', { name: 'Heure' }).fill('08:00');
  await expect(page.getByRole('checkbox', { name: 'lundi' })).toBeChecked();
  await page
    .getByRole('checkbox', { name: 'Exécuter des commandes dans la machine isolée' })
    .check();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  const taskRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Rapport hebdo' }) });
  await expect(taskRow).toContainText('Chaque lundi à 08:00');
  await page
    .getByRole('button', { name: 'Plus tard' })
    .click()
    .catch(() => undefined);

  const started = Date.now();
  await page.getByRole('button', { name: 'Exécuter « Rapport hebdo » maintenant' }).click();
  const run = page
    .getByRole('region', { name: 'Dernières exécutions' })
    .getByRole('row')
    .filter({ hasText: 'Rapport hebdo' })
    .first();
  await expect(run).toBeVisible();
  // Pendant le run : statut « En cours » visible en direct (schedule:changed).
  const sawRunning = await run
    .getByText('En cours')
    .waitFor({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  await expect(run).not.toContainText(/En file|En cours/, { timeout: TURN_TIMEOUT });
  const seconds = (Date.now() - started) / 1_000;
  const cells = (await run.getByRole('cell').allInnerTexts()).map((t) => t.trim());
  const files = await listFiles(workspace);
  const report = files.includes(REPORT) ? await readFile(join(workspace, REPORT), 'utf8') : '';
  const found = amounts(report);
  const totals = Object.fromEntries(
    Object.entries(TOTALS).map(([store, total]) => [
      store,
      found.some((n) => Math.abs(n - total) < 0.01),
    ]),
  );

  // Conversation du run : outils appelés et refus éventuels.
  await run.getByRole('button').first().click();
  const banner = page.getByRole('note', { name: 'Exécution planifiée' });
  await expect(banner).toBeVisible();
  const conversation = await page.getByRole('log', { name: 'Conversation' }).innerText();

  const result = {
    seconds,
    sawRunning,
    cells,
    files,
    totals,
    banner: await banner.innerText(),
    report,
  };
  console.log(`[rapport-hebdo] ${JSON.stringify(result, null, 2)}`);
  await testInfo.attach('rapport-hebdo', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('conversation', { body: conversation, contentType: 'text/plain' });
  await page.screenshot({ path: testInfo.outputPath('run.png') });

  expect(cells[3], 'statut du run').toBe('Réussi');
  expect(files).toContain(REPORT);
  expect(totals, 'totaux par magasin justes').toEqual({
    Bruxelles: true,
    Liège: true,
    Namur: true,
  });
});
