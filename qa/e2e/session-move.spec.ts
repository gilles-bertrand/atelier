/**
 * Déplacement d'une conversation (#21), en mode mock :
 * - une conversation d'un dossier entre, par glisser-déposer, dans le projet
 *   créé depuis ce dossier, et son tour suivant reçoit le contexte du projet ;
 * - une conversation d'un autre dossier est refusée pendant le survol, avec
 *   son motif, et reste hors projet ;
 * - le menu « Déplacer vers le projet… » la ressort du projet (« Hors projet »).
 */
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { IS_REAL, openWorkspace, send, sidebar, waitForTurnEnd } from './support/app.js';
import { expect, test } from './support/fixture.js';
import { textOf, type RecordedRequest } from './support/mock-llm.js';
import { MOVE_PROMPTS } from './support/scenarios.js';

test.skip(IS_REAL, 'Mode mock seulement : le déplacement ne dépend pas du modèle.');

/** La prochaine boîte « Choisir un dossier » renvoie `dir`. */
async function nextChosenFolder(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, dir);
}

/** Projet de chaque conversation, d'après le main (`session:list`). */
async function projectsByTitle(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(async () => {
    const api = (
      window as unknown as { atelier: { invoke: (c: string, r?: unknown) => Promise<unknown> } }
    ).atelier;
    const list = (await api.invoke('session:list', { limit: 50 })) as {
      value?: { title: string; projectId?: string }[];
    };
    return Object.fromEntries((list.value ?? []).map((s) => [s.title, s.projectId ?? null]));
  });
}

/** Prompt système de la requête du scénario `scenario`. */
function systemFor(requests: readonly RecordedRequest[], scenario: string): string {
  const request = requests.find((r) => r.scenario === scenario);
  return textOf(request?.messages.find((m) => m.role === 'system')?.content);
}

test('une conversation du dossier entre dans le projet créé depuis ce dossier', async ({
  atelier,
  llm,
}) => {
  const { app, page, workspace, root } = atelier;
  const folder = basename(workspace);
  const nav = await sidebar(page);

  // Une conversation dans le dossier, puis un projet créé depuis ce dossier : elle le rejoint.
  await openWorkspace(page);
  await send(page, MOVE_PROMPTS.first);
  await waitForTurnEnd(page);
  await nav.getByRole('button', { name: `Actions pour le dossier « ${folder} »` }).click();
  await page.getByRole('menuitem', { name: 'Créer un projet à partir de ce dossier' }).click();
  await expect(page.getByRole('tablist', { name: 'Sections du projet' })).toBeVisible();
  const projects = nav.getByRole('list', { name: 'Projets' });
  const projectRow = projects
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: folder, exact: true }) });
  await expect(projectRow).toHaveCount(1);

  // Une autre conversation dans le même dossier, ouverte hors projet.
  await nextChosenFolder(app, workspace);
  await nav.getByRole('button', { name: 'Ouvrir un dossier' }).click();
  await send(page, MOVE_PROMPTS.before);
  await waitForTurnEnd(page);
  expect((await projectsByTitle(page))[MOVE_PROMPTS.before]).toBeNull();
  const inFolder = nav.getByRole('list', { name: `Conversations du dossier ${folder}` });
  const row = inFolder.getByRole('listitem').filter({ hasText: MOVE_PROMPTS.before });

  // Glisser-déposer sur le projet : elle y entre, son dossier ne change pas.
  await row.dragTo(projectRow);
  await expect(
    nav
      .getByRole('list', { name: `Conversations du projet ${folder}` })
      .getByText(MOVE_PROMPTS.before),
  ).toBeVisible();
  await expect(page.getByTitle(`Ouvrir le projet « ${folder} »`)).toBeVisible();
  const moved = await projectsByTitle(page);
  expect(moved[MOVE_PROMPTS.before]).not.toBeNull();
  expect(moved[MOVE_PROMPTS.before]).toBe(moved[MOVE_PROMPTS.first]);

  // Le tour suivant reçoit le contexte du projet ; celui d'avant ne l'avait pas.
  await send(page, MOVE_PROMPTS.after);
  await waitForTurnEnd(page);
  expect(systemFor(llm.requests, 'déplacement : before')).not.toContain(`Projet : « ${folder} »`);
  expect(systemFor(llm.requests, 'déplacement : after')).toContain(`Projet : « ${folder} »`);
  const after = llm.requests.find((r) => r.scenario === 'déplacement : after');
  const userTexts = (after?.messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => textOf(m.content));
  expect(
    userTexts.some((t) => t.includes(MOVE_PROMPTS.before)),
    'historique conservé',
  ).toBe(true);

  // Une conversation d'un autre dossier : refusée au survol, avec son motif.
  const other = join(root, 'Autre');
  await mkdir(other);
  await nextChosenFolder(app, other);
  await nav.getByRole('button', { name: 'Ouvrir un dossier' }).click();
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeVisible();
  const otherRow = nav
    .getByRole('list', { name: 'Conversations du dossier Autre' })
    .getByRole('listitem')
    .first();
  await otherRow.hover();
  await page.mouse.down();
  await projectRow.hover({ position: { x: 40, y: 10 } });
  await projectRow.hover({ position: { x: 60, y: 12 } });
  await expect(nav.getByRole('tooltip')).toContainText(
    `Cette conversation travaille dans un autre dossier que celui du projet « ${folder} »`,
  );
  await expect(projectRow).not.toHaveAttribute('data-drop-target', 'allowed');
  await page.mouse.up();
  await expect(nav.getByRole('tooltip')).toHaveCount(0);
  expect((await projectsByTitle(page))['Nouvelle conversation']).toBeNull();

  // Menu « Déplacer vers le projet… » : « Hors projet » la ressort, dans son dossier.
  await nav
    .getByRole('button', { name: `Actions pour « ${MOVE_PROMPTS.before} »` })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Déplacer vers le projet…' }).click();
  await nav
    .getByRole('group', { name: `Déplacer « ${MOVE_PROMPTS.before} » vers :` })
    .getByRole('button', { name: 'Hors projet' })
    .click();
  await expect(inFolder.getByText(MOVE_PROMPTS.before)).toBeVisible();
  expect((await projectsByTitle(page))[MOVE_PROMPTS.before]).toBeNull();
});
