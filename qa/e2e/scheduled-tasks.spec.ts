/**
 * Prompts planifiés (ADR-002 §6, lot L4, ticket #20), en mode mock : création
 * d'une tâche, « Exécuter maintenant », run réussi avec un fichier produit,
 * refus tracé et « Autoriser pour cette tâche », aucune modale pendant un run,
 * conversations de runs absentes des « Récentes », plancher de 15 minutes.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { FIXTURES_DIR, IS_REAL, sidebar } from './support/app.js';
import { expect, test } from './support/fixture.js';
import { SCHEDULE_FILE, SCHEDULE_PROMPT } from './support/scenarios.js';

test.skip(IS_REAL, 'Mode mock seulement (le scénario réel est consigné dans docs/QA.md).');
test.use({ seed: [join(FIXTURES_DIR, 'demo-ventes')] });

/** Durée maximale d'un run en mock : lecture, écriture, compte rendu. */
const RUN_TIMEOUT = 30_000;

async function openSchedule(page: Page): Promise<void> {
  const nav = await sidebar(page);
  await nav.getByRole('button', { name: 'Tâches planifiées' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tâches planifiées' })).toBeVisible();
}

/**
 * Compte les modales ouvertes dans le renderer depuis l'appel : un run
 * planifié ne doit jamais en ouvrir (D4, refus sans témoin).
 */
async function watchDialogs(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __dialogs: number; __dialogObserver?: MutationObserver };
    w.__dialogs = 0;
    w.__dialogObserver?.disconnect();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          const found = node.matches('[role="dialog"],[role="alertdialog"]')
            ? 1
            : node.querySelectorAll('[role="dialog"],[role="alertdialog"]').length;
          w.__dialogs += found;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    w.__dialogObserver = observer;
  });
  return () => page.evaluate(() => (window as unknown as { __dialogs: number }).__dialogs);
}

interface TaskOptions {
  name: string;
  fileWrite: boolean;
}

async function createTask(page: Page, { name, fileWrite }: TaskOptions): Promise<void> {
  await page.getByRole('button', { name: 'Nouvelle tâche' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nouvelle tâche' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Nom' }).fill(name);
  await page.getByRole('button', { name: 'Choisir…' }).click();
  await expect(page.getByText('Aucun dossier choisi')).toBeHidden();
  await page.getByRole('textbox', { name: 'Demande' }).fill(SCHEDULE_PROMPT);
  await page.getByRole('combobox', { name: 'Fréquence' }).selectOption('interval');
  await page.getByRole('textbox', { name: 'Toutes les' }).fill('15');
  await page.getByRole('combobox', { name: 'Unité' }).selectOption('minutes');
  await expect(
    page.getByRole('list', { name: 'Prochaines exécutions' }).getByRole('listitem'),
  ).toHaveCount(3);
  const write = page.getByRole('checkbox', {
    name: 'Créer et modifier des fichiers dans le dossier',
  });
  await expect(write, 'case cochée par défaut (D4)').toBeChecked();
  await write.setChecked(fileWrite);
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tâches planifiées' })).toBeVisible();
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name }) });
  await expect(row).toContainText('Toutes les 15 minutes');
}

/** « Exécuter maintenant », puis attend la ligne du run dans « Dernières exécutions ». */
async function runNow(page: Page, name: string) {
  await page.getByRole('button', { name: `Exécuter « ${name} » maintenant` }).click();
  const runs = page.getByRole('region', { name: 'Dernières exécutions' });
  const row = runs.getByRole('row').filter({ hasText: name });
  await expect(row.first()).toBeVisible();
  await expect(row.first()).not.toContainText(/En file|En cours/, { timeout: RUN_TIMEOUT });
  return row.first();
}

/** Cellules d'une ligne de run : Date, Tâche, Déclencheur, Statut, Durée, Tokens, Fichiers, Refus, Compte rendu. */
async function runCells(row: ReturnType<Page['getByRole']>): Promise<string[]> {
  return (await row.getByRole('cell').allInnerTexts()).map((t) => t.trim());
}

test('tâche toutes les 15 minutes, « Exécuter maintenant » : run réussi, 1 fichier, sans modale', async ({
  atelier,
}) => {
  const { page, workspace } = atelier;
  await openSchedule(page);
  await expect(page.getByText('Aucune tâche planifiée')).toBeVisible();
  await createTask(page, { name: 'Note des ventes', fileWrite: true });

  // Proposée dès la première tâche (D1).
  await expect(page.getByText('Les tâches ne tournent que si Atelier est ouvert')).toBeVisible();
  await page.getByRole('button', { name: 'Plus tard' }).click();

  const dialogs = await watchDialogs(page);
  const row = await runNow(page, 'Note des ventes');
  const cells = await runCells(row);
  expect(cells[2], 'déclencheur').toBe('Manuel');
  expect(cells[3], 'statut').toBe('Réussi');
  expect(cells[6], 'fichiers produits').toBe('1');
  expect(cells[7], 'refus').toBe('0');
  expect(cells[8], 'compte rendu').toContain(`Fichier produit : ${SCHEDULE_FILE}`);
  expect(await dialogs(), 'aucune modale pendant le run').toBe(0);

  const written = await readFile(join(workspace, SCHEDULE_FILE), 'utf8');
  expect(written).toContain('Ventes de Bruxelles');

  // Tuiles et dernier statut de la tâche.
  await expect(
    page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Note des ventes' }) }),
  ).toContainText('Réussi');
  await expect(page.getByText('100 % de réussite')).toBeVisible();

  // La conversation du run n'est pas dans « Récentes » (D3)…
  const recent = (await sidebar(page)).getByRole('region', { name: 'Récentes' });
  await expect(recent.getByText(/Note des ventes/)).toHaveCount(0);

  // … mais s'ouvre depuis le tableau de bord, avec son bandeau.
  await row.getByRole('button', { name: /\d/ }).first().click();
  const banner = page.getByRole('note', { name: 'Exécution planifiée' });
  await expect(banner).toContainText('Exécution planifiée de « Note des ventes »');
  await expect(banner).toContainText('Réussi');
  await expect(banner.getByRole('button', { name: 'Autoriser pour cette tâche' })).toHaveCount(0);
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(SCHEDULE_PROMPT);
  await expect(recent.getByText(/Note des ventes/)).toHaveCount(0);
});

test('sans « Créer des fichiers » : 1 action refusée, « Autoriser pour cette tâche » pré-coche la case', async ({
  atelier,
}) => {
  const { page, workspace } = atelier;
  await openSchedule(page);
  await createTask(page, { name: 'Note sans écriture', fileWrite: false });
  await page.getByRole('button', { name: 'Plus tard' }).click();

  const dialogs = await watchDialogs(page);
  const row = await runNow(page, 'Note sans écriture');
  const cells = await runCells(row);
  // Un run avec des refus reste réussi, le tableau de bord le signale (D6).
  expect(cells[3], 'statut').toBe('Réussi');
  expect(cells[6], 'fichiers produits').toBe('0');
  expect(cells[7], 'refus').toBe('1');
  expect(await dialogs(), 'refus sans modale').toBe(0);
  await expect(readFile(join(workspace, SCHEDULE_FILE))).rejects.toThrow();
  await expect(page.getByRole('term').filter({ hasText: 'Actions refusées' })).toBeVisible();

  await row.getByRole('button', { name: /\d/ }).first().click();
  const banner = page.getByRole('note', { name: 'Exécution planifiée' });
  await expect(banner).toContainText('1 action refusée');
  await banner.getByRole('button', { name: 'Autoriser pour cette tâche' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Modifier « Note sans écriture »' }),
  ).toBeVisible();
  await expect(page.getByText('Les cases correspondant aux actions refusées')).toBeVisible();
  const write = page.getByRole('checkbox', {
    name: 'Créer et modifier des fichiers dans le dossier',
  });
  await expect(write).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Exécuter des commandes dans la machine isolée' }),
    'seule la case du refus est cochée',
  ).not.toBeChecked();

  // Enregistrer élargit la politique : le run suivant écrit le fichier.
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tâches planifiées' })).toBeVisible();
  const second = await runNow(page, 'Note sans écriture');
  await expect(second).toContainText('Réussi');
  const cells2 = await runCells(second);
  expect(cells2[6], 'fichier produit après autorisation').toBe('1');
  expect(cells2[7]).toBe('0');
});

test('récurrence de 10 minutes : message de validateSchedule, enregistrement impossible', async ({
  atelier,
}) => {
  const { page } = atelier;
  await openSchedule(page);
  await page.getByRole('button', { name: 'Nouvelle tâche' }).click();
  await page.getByRole('combobox', { name: 'Fréquence' }).selectOption('interval');
  const every = page.getByRole('textbox', { name: 'Toutes les' });
  await every.fill('10');
  await expect(page.getByText('L’intervalle doit être d’au moins 15 minutes.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Prochaines exécutions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();

  await every.fill('15');
  await expect(page.getByText('L’intervalle doit être d’au moins 15 minutes.')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
});
