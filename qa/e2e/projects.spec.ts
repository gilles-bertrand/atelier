/**
 * Projets (ADR-003 §7, lot L5, ticket #22), en mode mock :
 * - projet sur trois dossiers (principal, « Compta » en écriture, « Archives »
 *   en lecture seule) : mémoire écrite avec accord, fichier écrit dans Compta,
 *   écriture refusée dans Archives, artefact publié et affiché isolé ;
 * - la mémoire revient dans le prompt de la conversation suivante ;
 * - une tâche du projet exécutée deux fois publie la même page en v1 puis v2.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  autoApprove,
  FIXTURES_DIR,
  IS_REAL,
  send,
  sidebar,
  waitForTurnEnd,
} from './support/app.js';
import { expect, test } from './support/fixture.js';
import { textOf } from './support/mock-llm.js';
import {
  ARTIFACT_FILE,
  ARTIFACT_TITLE,
  artifactTrap,
  PROJECT_FOLLOWUP,
  PROJECT_NOTE,
  PROJECT_PROMPT,
  PROJECT_TASK_PROMPT,
} from './support/scenarios.js';

test.skip(IS_REAL, 'Mode mock seulement (le scénario réel est consigné dans docs/QA.md).');
test.use({ seed: [join(FIXTURES_DIR, 'demo-ventes')] });

/** Durée maximale d'un run planifié en mock. */
const RUN_TIMEOUT = 30_000;

/** La prochaine boîte « Choisir un dossier » renvoie `dir`. */
async function nextChosenFolder(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, dir);
}

async function projectPage(page: Page): Promise<void> {
  await expect(page.getByRole('tablist', { name: 'Sections du projet' })).toBeVisible();
}

test('projet sur trois dossiers : mémoire, écriture, lecture seule, artefact isolé', async ({
  atelier,
  llm,
}) => {
  const { app, page, workspace, root } = atelier;
  const compta = join(root, 'Compta');
  const archives = join(root, 'Archives');
  await mkdir(compta);
  await mkdir(archives);
  await writeFile(join(archives, 'bilan-2025.md'), '# Bilan 2025\n');

  // Création : dossier de travail existant comme principal, deux dossiers rattachés.
  const nav = await sidebar(page);
  await nav.getByRole('button', { name: 'Nouveau projet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouveau projet' });
  await dialog.getByRole('textbox', { name: 'Nom' }).fill('Ventes');
  await dialog.getByRole('radio', { name: /Utiliser un dossier existant/ }).check();
  await nextChosenFolder(app, workspace);
  await dialog.getByRole('button', { name: 'Choisir…' }).click();
  await expect(dialog.getByText(workspace)).toBeVisible();
  await nextChosenFolder(app, compta);
  await dialog.getByRole('button', { name: 'Ajouter un dossier' }).click();
  await nextChosenFolder(app, archives);
  await dialog.getByRole('button', { name: 'Ajouter un dossier' }).click();
  await dialog.getByRole('combobox', { name: 'Accès au dossier Archives' }).selectOption('read');
  await dialog.getByRole('button', { name: 'Créer le projet' }).click();
  await projectPage(page);
  await page.getByRole('tab', { name: 'Dossiers' }).click();
  await expect(page.getByRole('list', { name: 'Dossiers du projet' })).toContainText(compta);

  // Cible de la redirection piégée de l'artefact : un serveur local qui compte les requêtes.
  const hits: string[] = [];
  const trap = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.end('fuite');
  });
  await new Promise<void>((resolve) => {
    trap.listen(0, '127.0.0.1', resolve);
  });
  artifactTrap.url = `http://127.0.0.1:${String((trap.address() as AddressInfo).port)}/fuite?d=1`;

  // Conversation du projet : chaque écriture (mémoire comprise) est demandée.
  await page.getByRole('button', { name: 'Nouvelle conversation dans le projet' }).click();
  await expect(page.getByTitle('Ouvrir le projet « Ventes »')).toBeVisible();
  const approvals = autoApprove(page, workspace);
  await send(page, PROJECT_PROMPT);
  await waitForTurnEnd(page);
  await approvals.stop();
  expect(approvals.records.map((r) => r.title)).toContain(
    `Retenir dans la mémoire du projet : « ${PROJECT_NOTE} »`,
  );

  expect(await readFile(join(compta, 'synthese.md'), 'utf8')).toContain('Synthèse');
  await expect(readFile(join(archives, 'brouillon.md'))).rejects.toThrow();
  const refusal = llm.requests
    .filter((r) => r.scenario === 'projet')
    .flatMap((r) => r.messages)
    .filter((m) => m.role === 'tool')
    .map((m) => textOf(m.content));
  expect(refusal.some((t) => t.includes('« Archives » est en lecture seule'))).toBe(true);
  expect(await readFile(join(workspace, ARTIFACT_FILE), 'utf8')).toContain(ARTIFACT_TITLE);

  // La carte de l'artefact ouvre la page, isolée : scripts permis, rien d'autre.
  await page
    .getByRole('button', { name: `Ouvrir l’artefact « ${ARTIFACT_TITLE} » (version 1)` })
    .click();
  const frameElement = page.getByTitle(`Page « ${ARTIFACT_TITLE} »`);
  await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts');
  const inner = page.frameLocator(`iframe[title="Page « ${ARTIFACT_TITLE} »"]`);
  await expect(inner.getByRole('heading', { name: ARTIFACT_TITLE })).toBeVisible();
  await expect(inner.locator('body'), 'script de la page exécuté').toHaveAttribute('data-ok', '1');
  const frame = page.frames().find((f) => f.url().startsWith('atelier-artifact://'));
  expect(frame, 'cadre de l’artefact').toBeDefined();
  if (frame) {
    expect(await frame.evaluate(() => typeof (window as { atelier?: unknown }).atelier)).toBe(
      'undefined',
    );
    const network = await frame.evaluate(() =>
      fetch('https://example.com/').then(
        () => 'ouvert',
        () => 'bloqué',
      ),
    );
    expect(network, 'aucun réseau depuis un artefact').toBe('bloqué');
  }
  // La page porte une <meta http-equiv="refresh"> vers le serveur piège (après 1 s) :
  // la navigation du cadre est bloquée avant toute requête (garde will-frame-navigate
  // du main et frame-src de la CSP de l'app). Chromium affiche alors sa page
  // d'erreur dans le cadre : la page piégée perd son affichage, rien ne sort.
  await page.waitForTimeout(2_500);
  expect(hits, 'aucune requête reçue par la cible de la redirection').toEqual([]);
  // La redirection a bien été tentée puis bloquée : le cadre a quitté l'artefact pour
  // la page d'erreur de Chromium (sinon ce test passerait sans rien prouver).
  expect(page.frames().some((f) => f.url().startsWith('chrome-error://'))).toBe(true);
  expect(page.frames().some((f) => f.url().startsWith(artifactTrap.url))).toBe(false);
  await new Promise<void>((resolve) => {
    trap.close(() => {
      resolve();
    });
  });

  // La mémoire, écrite avec accord, revient dans la conversation suivante.
  await page.getByTitle('Ouvrir le projet « Ventes »').click();
  await projectPage(page);
  await page.getByRole('tab', { name: 'Mémoire et consignes' }).click();
  await expect(page.getByText(PROJECT_NOTE)).toBeVisible();
  await page.getByRole('button', { name: 'Nouvelle conversation dans le projet' }).click();
  await send(page, PROJECT_FOLLOWUP);
  await waitForTurnEnd(page);
  const followup = llm.requests.find((r) => r.scenario === 'projet : suite');
  const system = textOf(followup?.messages.find((m) => m.role === 'system')?.content);
  expect(system).toContain('Projet : « Ventes »');
  expect(system).toContain(PROJECT_NOTE);
  expect(system).toContain('Archives');
  expect(system).toContain('lecture seule');
});

test('tâche du projet exécutée deux fois : la même page passe de v1 à v2', async ({ atelier }) => {
  const { page } = atelier;
  const nav = await sidebar(page);
  await nav.getByRole('button', { name: 'Nouveau projet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouveau projet' });
  await dialog.getByRole('textbox', { name: 'Nom' }).fill('Rapports');
  await dialog.getByRole('button', { name: 'Créer le projet' }).click();
  await projectPage(page);

  await page.getByRole('tab', { name: 'Tâches' }).click();
  await page.getByRole('button', { name: 'Nouvelle tâche' }).click();
  await expect(page.getByRole('combobox', { name: 'Projet' })).toHaveValue(/.+/);
  await page.getByRole('textbox', { name: 'Nom' }).fill('Tableau hebdo');
  await page.getByRole('textbox', { name: 'Demande' }).fill(PROJECT_TASK_PROMPT);
  await page.getByRole('combobox', { name: 'Fréquence' }).selectOption('interval');
  await page.getByRole('textbox', { name: 'Toutes les' }).fill('15');
  await page.getByRole('combobox', { name: 'Unité' }).selectOption('minutes');
  await expect(
    page.getByRole('checkbox', {
      name: 'Créer et modifier des fichiers dans les dossiers du projet',
    }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tâches planifiées' })).toBeVisible();
  await page.getByRole('button', { name: 'Plus tard' }).click();

  const runs = page.getByRole('region', { name: 'Dernières exécutions' });
  for (const expected of [1, 2]) {
    await page.getByRole('button', { name: 'Exécuter « Tableau hebdo » maintenant' }).click();
    const rows = runs.getByRole('row').filter({ hasText: 'Tableau hebdo' });
    await expect(rows).toHaveCount(expected);
    await expect(rows.first()).toContainText('Réussi', { timeout: RUN_TIMEOUT });
  }

  await (await sidebar(page)).getByRole('button', { name: 'Rapports', exact: true }).click();
  await projectPage(page);
  await page.getByRole('tab', { name: 'Artefacts' }).click();
  const card = page.getByRole('button', { name: `Ouvrir l’artefact « ${ARTIFACT_TITLE} »` });
  await expect(card).toContainText('v2');
  await expect(card).toContainText('Tableau hebdo');
  await card.click();
  const versions = page.getByRole('combobox', { name: 'Version affichée' });
  await expect(versions.getByRole('option')).toHaveCount(2);
  await expect(page.getByTitle(`Page « ${ARTIFACT_TITLE} »`)).toHaveAttribute(
    'src',
    /atelier-artifact:\/\/.+\/v2\//,
  );
});
