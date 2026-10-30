/**
 * Modèle par conversation (#13, QA #18), en mode mock : le faux serveur sert
 * plusieurs modèles aux capacités variées et `/api/ps` (un seul modèle en
 * mémoire, comme le serveur d'Atelier).
 *
 * Couvre le sélecteur du Composer (D2 : entrée grisée, badge « non testé »,
 * embeddings masqués ; D3 : pastille prêt / à froid, avertissement,
 * « Chargement du modèle… »), le séparateur « Modèle : X » et la ventilation
 * par modèle de Réglages › Utilisation (D1), la persistance à la réouverture,
 * le refus pendant un tour (`agent/busy`) et l'erreur d'un modèle sans outils.
 *
 * La bascule réelle (qwen3.5:9b ↔ 35b, temps de chargement, compaction
 * anticipée) se fait à la main sur l'Ollama local : voir docs/QA.md.
 */
import type { Page } from '@playwright/test';
import { IS_REAL, launchAtelier, openWorkspace, send, waitForTurnEnd } from './support/app.js';
import { expect, test } from './support/fixture.js';
import type { MockModel } from './support/mock-llm.js';
import { MODEL_PROMPTS } from './support/scenarios.js';

const QWEN_35B = 'qwen3.5:35b';
const QWEN_9B = 'qwen3.5:9b';
/** Hors famille Qwen 3.5 : utilisable, badge « non testé », sans vision. */
const LLAMA = 'llama3.1:8b';
/** Sans `tools` : grisé dans le sélecteur, refusé par le serveur. */
const GEMMA = 'gemma3:4b';
/** Embedding : jamais proposé. */
const EMBED = 'nomic-embed-text:latest';

const MODELS: MockModel[] = [
  {
    name: QWEN_35B,
    family: 'qwen35moe',
    capabilities: ['completion', 'vision', 'thinking', 'tools'],
    numCtx: 32_768,
    sizeBytes: 23_000_000_000,
  },
  {
    name: QWEN_9B,
    family: 'qwen35',
    capabilities: ['completion', 'vision', 'thinking', 'tools'],
    numCtx: 16_384,
    sizeBytes: 6_600_000_000,
  },
  {
    name: LLAMA,
    family: 'llama',
    capabilities: ['completion', 'tools'],
    numCtx: 8_192,
    sizeBytes: 4_900_000_000,
  },
  {
    name: GEMMA,
    family: 'gemma3',
    capabilities: ['completion', 'vision'],
    numCtx: 8_192,
    sizeBytes: 3_300_000_000,
  },
  {
    name: EMBED,
    family: 'nomic-bert',
    capabilities: ['embedding'],
    numCtx: 2_048,
    sizeBytes: 274_000_000,
  },
];

test.skip(IS_REAL, 'Mode mock seulement : la campagne réelle est consignée dans docs/QA.md.');
// Valeurs tableau : forme tuple, sinon Playwright lit `[valeur, options]`.
test.use({
  mockModels: [MODELS, { scope: 'test' }],
  mockLoaded: [[QWEN_35B], { scope: 'test' }],
  defaultModel: QWEN_35B,
});

type IpcResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/** Appel IPC brut depuis le renderer (même canal que l'UI). */
async function invoke<T>(page: Page, channel: string, request?: unknown): Promise<IpcResult<T>> {
  return page.evaluate(
    async ({ channel, request }) => {
      const api = (
        window as unknown as { atelier: { invoke: (c: string, r?: unknown) => Promise<unknown> } }
      ).atelier;
      return (await api.invoke(channel, request)) as IpcResult<T>;
    },
    { channel, request },
  );
}

interface SessionInfo {
  id: string;
  title: string;
  model?: string;
}

async function sessions(page: Page): Promise<SessionInfo[]> {
  const result = await invoke<SessionInfo[]>(page, 'session:list', { limit: 20 });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Modèle de chaque réponse de l'assistant, d'après l'historique persistant. */
async function assistantModels(page: Page, sessionId: string): Promise<(string | undefined)[]> {
  const result = await invoke<{ messages: { role: string; model?: string }[] }>(
    page,
    'session:open',
    { sessionId },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value.messages.filter((m) => m.role === 'assistant').map((m) => m.model);
}

function pickerButton(page: Page) {
  return page.getByRole('button', { name: /^Modèle : / });
}

async function openPicker(page: Page) {
  await pickerButton(page).click();
  const list = page.getByRole('listbox', { name: 'Modèles du serveur' });
  await expect(list.getByRole('option').first()).toBeVisible();
  return list;
}

function option(page: Page, name: string) {
  return page
    .getByRole('listbox', { name: 'Modèles du serveur' })
    .getByRole('option')
    .filter({ hasText: name });
}

async function chooseModel(page: Page, name: string): Promise<void> {
  await openPicker(page);
  await option(page, name).click();
  await expect(pickerButton(page)).toHaveAccessibleName(`Modèle : ${name}`);
}

test('sélecteur : capacités, badge « non testé », entrée grisée, embeddings masqués', async ({
  atelier,
}) => {
  const { page } = atelier;
  await openWorkspace(page);
  await expect(pickerButton(page)).toHaveAccessibleName(`Modèle : ${QWEN_35B}`);

  const list = await openPicker(page);
  const options = list.getByRole('option');
  // Défaut recommandé en tête, puis les profils connus, puis les autres par nom ; pas d'embedding.
  await expect(options).toHaveCount(4);
  const names = await options.evaluateAll((items) =>
    items.map((item) => item.querySelector('.font-medium')?.textContent ?? ''),
  );
  expect(names).toEqual([QWEN_35B, QWEN_9B, GEMMA, LLAMA]);
  await expect(list.getByText(EMBED)).toHaveCount(0);

  // Modèle courant coché ; pastille prêt (en mémoire) / à froid (D3).
  await expect(option(page, QWEN_35B)).toHaveAttribute('aria-selected', 'true');
  await expect(option(page, QWEN_35B)).toContainText('prêt');
  await expect(option(page, QWEN_9B)).toContainText('à froid');
  await expect(option(page, QWEN_9B)).toContainText('contexte 16 384 tokens');
  await expect(option(page, QWEN_9B)).toContainText('Léger (16 Go)');

  // D2 : hors Qwen 3.5 → « non testé » ; les dérivés Qwen n'ont pas le badge.
  await expect(option(page, LLAMA)).toContainText('non testé');
  await expect(option(page, QWEN_9B)).not.toContainText('non testé');

  // D2 : sans outils → grisé, raison affichée, clic sans effet.
  const gemma = option(page, GEMMA);
  await expect(gemma).toHaveAttribute('aria-disabled', 'true');
  await expect(gemma).toContainText('Indisponible : ne sait pas utiliser les outils');
  // `force` : l'option est `aria-disabled`, on vérifie qu'un vrai clic reste sans effet.
  await gemma.click({ force: true });
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(pickerButton(page)).toHaveAccessibleName(`Modèle : ${QWEN_35B}`);
  await expect(pickerButton(page)).toBeFocused();

  // Le main refuse aussi, indépendamment de l'UI.
  const [session] = await sessions(page);
  if (!session) throw new Error('Aucune conversation');
  const refused = await invoke(page, 'session:set-model', { sessionId: session.id, model: GEMMA });
  expect(refused.ok ? undefined : refused.error.code).toBe('llm/model_unsupported');
  const missing = await invoke(page, 'session:set-model', {
    sessionId: session.id,
    model: 'absent:1b',
  });
  expect(missing.ok ? undefined : missing.error.code).toBe('llm/model_not_found');
  expect((await sessions(page))[0]?.model).toBe(QWEN_35B);
});

test('sélecteur au clavier : flèches, Entrée, Échap', async ({ atelier }) => {
  const { page } = atelier;
  await openWorkspace(page);
  const list = await openPicker(page);
  await expect(list).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(pickerButton(page)).toHaveAccessibleName(`Modèle : ${QWEN_9B}`);
  await expect(pickerButton(page)).toBeFocused();
});

test('changement entre deux tours : avertissement à froid, chargement, séparateur, usage par modèle', async ({
  atelier,
  llm,
}) => {
  const { page } = atelier;
  await openWorkspace(page);

  await send(page, MODEL_PROMPTS.first);
  await waitForTurnEnd(page);
  // Une seule réponse, pas encore de séparateur.
  await expect(page.getByRole('separator', { name: /^Modèle : / })).toHaveCount(0);

  // 9b est à froid : avertissement non bloquant dès le choix (D3).
  await chooseModel(page, QWEN_9B);
  await expect(page.getByText(/Premier message plus lent : le serveur doit charger/)).toBeVisible();

  await send(page, MODEL_PROMPTS.second);
  await expect(page.getByText('Chargement du modèle sur le serveur…')).toBeVisible();
  await waitForTurnEnd(page);
  await expect(page.getByText(/Premier message plus lent/)).toHaveCount(0);

  // D1 : séparateur avant la réponse du nouveau modèle.
  await expect(page.getByRole('separator', { name: `Modèle : ${QWEN_9B}` })).toBeVisible();

  // Le serveur a reçu chaque tour sur le bon modèle ; 9b est maintenant le seul en mémoire.
  const chat = llm.requests.filter((r) => r.scenario === 'modèle par conversation');
  expect(chat.map((r) => r.model)).toEqual([QWEN_35B, QWEN_9B]);
  expect(llm.mock?.loaded()).toEqual([QWEN_9B]);

  // Chaque réponse garde son modèle dans l'historique.
  const [session] = await sessions(page);
  if (!session) throw new Error('Aucune conversation');
  expect(session.model).toBe(QWEN_9B);
  expect(await assistantModels(page, session.id)).toEqual([QWEN_35B, QWEN_9B]);

  // Réglages › Utilisation : un tour par modèle.
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
  for (const model of [QWEN_35B, QWEN_9B]) {
    const row = table
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: model }) });
    await expect(row).toHaveCount(1);
    // Colonne « Tours » : 1.
    await expect(row.getByRole('cell').first()).toHaveText('1');
  }
});

test('modèle conservé à la réouverture, sans changer le défaut des nouvelles conversations', async ({
  atelier,
  llm,
}) => {
  const { page } = atelier;
  await openWorkspace(page);
  await chooseModel(page, LLAMA);
  await send(page, MODEL_PROMPTS.first);
  await waitForTurnEnd(page);
  const [session] = await sessions(page);
  if (!session) throw new Error('Aucune conversation');
  expect(session.model).toBe(LLAMA);

  await atelier.close({ keep: true });
  const again = await launchAtelier({ llmUrl: llm.url, model: QWEN_35B, root: atelier.root });
  try {
    const page2 = again.page;
    await page2
      .getByRole('navigation', { name: 'Barre latérale' })
      .getByRole('button', { name: session.title })
      .first()
      .click();
    await expect(pickerButton(page2)).toHaveAccessibleName(`Modèle : ${LLAMA}`);
    expect(await assistantModels(page2, session.id)).toEqual([LLAMA]);

    // Une nouvelle conversation part du défaut des Réglages (D1).
    await page2
      .getByRole('navigation', { name: 'Barre latérale' })
      .getByRole('button', { name: /^Nouvelle conversation/ })
      .first()
      .click();
    // Elle s'ouvre directement dans le dernier dossier.
    await expect(page2.getByRole('textbox', { name: 'Votre message' })).toBeVisible();
    await expect(pickerButton(page2)).toHaveAccessibleName(`Modèle : ${QWEN_35B}`);
    const all = await sessions(page2);
    expect(all.find((s) => s.id === session.id)?.model).toBe(LLAMA);
  } finally {
    await again.close({ keep: true });
  }
});

test('changement refusé pendant un tour (agent/busy), possible après', async ({ atelier }) => {
  const { page } = atelier;
  await openWorkspace(page);
  await send(page, MODEL_PROMPTS.slow);
  await expect(page.getByRole('button', { name: 'Arrêter', exact: true })).toBeVisible();

  await expect(pickerButton(page)).toBeDisabled();
  await expect(pickerButton(page)).toHaveAttribute('title', 'Modifiable entre deux messages');
  const [session] = await sessions(page);
  if (!session) throw new Error('Aucune conversation');
  const busy = await invoke(page, 'session:set-model', { sessionId: session.id, model: QWEN_9B });
  expect(busy.ok ? undefined : busy.error.code).toBe('agent/busy');

  await waitForTurnEnd(page);
  expect((await sessions(page))[0]?.model).toBe(QWEN_35B);
  await expect(pickerButton(page)).toBeEnabled();
  await chooseModel(page, QWEN_9B);
});

test('serveur sans /api/ps : ni pastille ni avertissement à froid', async ({ atelier, llm }) => {
  llm.mock?.setLoaded(undefined);
  const { page } = atelier;
  await openWorkspace(page);
  await openPicker(page);
  await expect(option(page, QWEN_9B)).not.toContainText('à froid');
  await expect(option(page, QWEN_35B)).not.toContainText('prêt');
  await option(page, QWEN_9B).click();
  await expect(pickerButton(page)).toHaveAccessibleName(`Modèle : ${QWEN_9B}`);
  await expect(page.getByText(/Premier message plus lent/)).toHaveCount(0);
});

test.describe('modèle par défaut sans outils', () => {
  test.use({ defaultModel: GEMMA });

  test('erreur lisible et « Choisir un autre modèle » ouvre le sélecteur', async ({ atelier }) => {
    const { page } = atelier;
    await openWorkspace(page);
    await send(page, MODEL_PROMPTS.first);
    await expect(page.getByText('La réponse n’a pas pu aboutir')).toBeVisible();
    await page.getByRole('button', { name: 'Choisir un autre modèle' }).click();
    await expect(page.getByRole('listbox', { name: 'Modèles du serveur' })).toBeVisible();
    await option(page, QWEN_35B).click();
    await expect(pickerButton(page)).toHaveAccessibleName(`Modèle : ${QWEN_35B}`);
    await page.getByRole('button', { name: 'Réessayer' }).click();
    await waitForTurnEnd(page);
    await expect(page.getByText('Bonjour, je suis l’assistant d’Atelier.')).toBeVisible();
  });
});
