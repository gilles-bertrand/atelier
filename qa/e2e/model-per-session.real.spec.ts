/**
 * Modèle par conversation (#13, QA #18), en mode réel sur un Ollama LOCAL :
 * bascule qwen3.5:9b ↔ qwen3.5:35b dans une même conversation, avec le temps
 * de chaque tour, puis compaction anticipée en passant à un modèle de fenêtre
 * plus petite (Modelfile dérivé de qwen3.5:9b, `num_ctx` réduit).
 *
 * Lancement (jamais en CI, jamais sur l'Ollama partagé sans prévenir) :
 *   ollama create qa-9b-ctx8k -f - <<< $'FROM qwen3.5:9b\nPARAMETER num_ctx 8192'
 *   ATELIER_E2E_MODE=real ATELIER_E2E_MODEL=qwen3.5:9b \
 *     pnpm exec playwright test e2e/model-per-session.real.spec.ts
 * Résultats : docs/QA.md, « Modèle par conversation ».
 */
import type { Page, TestInfo } from '@playwright/test';
import { IS_REAL, openWorkspace, send, waitForTurnEnd } from './support/app.js';
import { expect, REAL_LLM_URL, test } from './support/fixture.js';

const QWEN_9B = 'qwen3.5:9b';
const QWEN_35B = 'qwen3.5:35b';
/** Dérivé de qwen3.5:9b avec une petite fenêtre (`ATELIER_E2E_SMALL_MODEL`). */
const SMALL = process.env['ATELIER_E2E_SMALL_MODEL'] ?? 'qa-9b-ctx8k';
const PROMPT = 'Réponds uniquement par le mot OK, sans utiliser d’outil.';

test.skip(!IS_REAL, 'Mode réel seulement (Ollama local).');
test.skip(
  process.env['ATELIER_E2E_MODEL'] !== QWEN_9B,
  `Lancer avec ATELIER_E2E_MODEL=${QWEN_9B}.`,
);

async function ollama<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${REAL_LLM_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
}

async function loadedModels(): Promise<string[]> {
  const ps = await ollama<{ models: { name: string }[] }>('/api/ps');
  return ps.models.map((m) => m.name);
}

/** Décharge tout : chaque tour part d'un serveur à froid connu. */
async function unloadAll(): Promise<void> {
  for (const name of await loadedModels()) {
    await ollama('/api/generate', { model: name, keep_alive: 0 });
  }
}

function pickerButton(page: Page) {
  return page.getByRole('button', { name: /^Modèle : / });
}

function option(page: Page, name: string) {
  return page
    .getByRole('listbox', { name: 'Modèles du serveur' })
    .getByRole('option')
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function chooseModel(page: Page, name: string): Promise<string> {
  await pickerButton(page).click();
  const target = option(page, name);
  await expect(target).toBeVisible();
  const state = (await target.textContent())?.includes('à froid') ? 'à froid' : 'prêt';
  await target.click();
  await expect(pickerButton(page)).toHaveAccessibleName(`Modèle : ${name}`);
  return state;
}

interface TurnMeasure {
  model: string;
  pickerState: string;
  loadingShown: boolean;
  seconds: number;
  loadedAfter: string[];
}

/** Envoie un message et mesure le tour (envoi → « Envoyer » de retour). */
async function timedTurn(page: Page, model: string, pickerState: string): Promise<TurnMeasure> {
  const started = Date.now();
  await send(page, PROMPT);
  const loading = page.getByText('Chargement du modèle sur le serveur…');
  const loadingShown = await loading
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  await waitForTurnEnd(page);
  // waitForTurnEnd attend 2 s de stabilité.
  const seconds = (Date.now() - started - 2_000) / 1_000;
  return { model, pickerState, loadingShown, seconds, loadedAfter: await loadedModels() };
}

async function report(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value, null, 2);
  console.log(`[${name}] ${body}`);
  await testInfo.attach(name, { body, contentType: 'application/json' });
}

async function usageRows(page: Page): Promise<string[]> {
  await page
    .getByRole('navigation', { name: 'Barre latérale' })
    .getByRole('button', { name: 'Réglages' })
    .click();
  await page
    .getByRole('navigation', { name: 'Rubriques des réglages' })
    .getByRole('button', { name: 'Utilisation' })
    .click();
  const table = page.getByRole('table', { name: 'Consommation par modèle' });
  await expect(table).toBeVisible();
  return table.getByRole('row').allInnerTexts();
}

test('bascule qwen3.5:9b ↔ 35b dans une conversation : temps de chaque tour', async ({
  atelier,
}, testInfo) => {
  const { page } = atelier;
  await unloadAll();
  await openWorkspace(page);

  const turns: TurnMeasure[] = [];
  await pickerButton(page).click();
  const first = (await option(page, QWEN_9B).textContent())?.includes('à froid')
    ? 'à froid'
    : 'prêt';
  await page.keyboard.press('Escape');
  turns.push(await timedTurn(page, QWEN_9B, first));

  const to35 = await chooseModel(page, QWEN_35B);
  const coldWarning = await page.getByText(/Premier message plus lent/).isVisible();
  turns.push(await timedTurn(page, QWEN_35B, to35));

  const back = await chooseModel(page, QWEN_9B);
  turns.push(await timedTurn(page, QWEN_9B, back));
  // Témoin : un tour de plus sur le même modèle, déjà chargé.
  turns.push(await timedTurn(page, QWEN_9B, 'prêt'));

  const separators = await page.getByRole('separator', { name: /^Modèle : / }).allInnerTexts();
  await report(testInfo, 'bascule', { turns, coldWarning, separators });
  await report(testInfo, 'utilisation', await usageRows(page));

  expect(turns.map((t) => t.loadedAfter.includes(t.model))).toEqual([true, true, true, true]);
  expect(separators).toEqual([`Modèle : ${QWEN_35B}`, `Modèle : ${QWEN_9B}`]);
});

test('compaction anticipée en passant à une fenêtre plus petite', async ({ atelier }, testInfo) => {
  const { page } = atelier;
  const models = await ollama<{ models: { name: string }[] }>('/api/tags');
  test.skip(
    !models.models.some((m) => m.name === SMALL || m.name === `${SMALL}:latest`),
    `Modèle ${SMALL} absent : créez-le (voir l'en-tête du fichier).`,
  );
  await openWorkspace(page);

  // Un premier tour copieux sur 9b (grande fenêtre) : ~5 000 tokens de texte.
  const paragraph =
    'Le rapport trimestriel décrit les ventes de chaque magasin, les stocks, les retours clients et les actions prévues pour le trimestre suivant. ';
  const long = `Voici des notes à garder en tête :\n${paragraph.repeat(160)}\nRéponds uniquement par « Noté ».`;
  await send(page, long);
  await waitForTurnEnd(page);

  await chooseModel(page, `${SMALL}${SMALL.includes(':') ? '' : ':latest'}`);
  const started = Date.now();
  await send(page, 'Résume mes notes en une phrase.');
  await waitForTurnEnd(page);
  const seconds = (Date.now() - started - 2_000) / 1_000;

  const rows = await usageRows(page);
  const compactionLogs = atelier.logs.join('').match(/compaction[^\n]*/g) ?? [];
  await report(testInfo, 'compaction', { seconds, rows, compactionLogs });
  expect(
    compactionLogs.length,
    'compaction attendue avant le tour du petit modèle',
  ).toBeGreaterThan(0);
});
