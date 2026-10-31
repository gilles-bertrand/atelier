/**
 * Projets (ADR-003, lot L5, ticket #22), scénario réel « tableau de bord hebdo » :
 * un vrai modèle (Ollama local), la VM Lima de l'app, et un projet sur deux
 * dossiers. Le principal contient les CSV de `fixtures/demo-ventes` ; « Archives »
 * est en lecture seule.
 *
 * Contrôles stricts (l'app) : création du projet, imbrication refusée, runs
 * réussis, dossier en lecture seule dans la VM. Contrôles souples (le modèle) :
 * skill chargé, page autonome, totaux justes, mémoire demandée, même fichier
 * republié. Tous les constats sont joints au rapport, même en cas d'échec.
 *
 * Lancement (jamais en CI) :
 *   ATELIER_E2E_MODE=real ATELIER_E2E_MODEL=atelier \
 *     pnpm exec playwright test e2e/projects.real.spec.ts
 * Résultats : docs/QA.md, « Projets ».
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from '@playwright/test';
import { chooseLimaHome } from '@atelier/sandbox';
import {
  autoApprove,
  describeCalls,
  DESKTOP_DIR,
  FIXTURES_DIR,
  IS_REAL,
  listFiles,
  send,
  sessionToolCalls,
  sidebar,
  TURN_TIMEOUT,
  waitForSandbox,
  waitForTurnEnd,
} from './support/app.js';
import { expect, test } from './support/fixture.js';

test.skip(!IS_REAL, 'Mode réel seulement (Ollama local et VM).');
test.use({ seed: [join(FIXTURES_DIR, 'demo-ventes')] });

const PROMPT =
  'Fais-moi un tableau de bord des ventes par magasin, publie-le, et retiens que le client ' +
  'veut une synthèse mensuelle.';
const TASK_PROMPT =
  'Mets à jour le tableau de bord des ventes par magasin à partir des fichiers CSV du dossier ' +
  'principal, puis republie-le.';
/** Totaux attendus (somme de la colonne montant de chaque CSV). */
const TOTALS: Record<string, number> = { Bruxelles: 40_337.5, Liège: 28_277.1, Namur: 20_622.5 };
/** Pages publiées : `Artefacts/*.html` dans le dossier principal. */
const ARTIFACT_PAGE = /^Artefacts\/[^/]+\.html?$/;

/** Montants d'un texte, en nombres (« 40 337,50 », « 40337.5 », « 40,337.50 »…). */
function amounts(text: string): number[] {
  return [...text.matchAll(/\d[\d\s.,]*\d/g)]
    .map((m) => m[0].replace(/\s/g, ''))
    .map((raw) =>
      /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''),
    )
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** La prochaine boîte « Choisir un dossier » renvoie `dir`. */
async function nextChosenFolder(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, dir);
}

async function projectPage(page: Page): Promise<void> {
  await expect(page.getByRole('tablist', { name: 'Sections du projet' })).toBeVisible();
}

/** Contenu brut (JSON) de la conversation la plus récente, messages injectés compris. */
async function sessionDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    type Result<T> = { ok: boolean; value?: T };
    const api = (
      window as unknown as { atelier: { invoke: (c: string, r?: unknown) => Promise<unknown> } }
    ).atelier;
    const list = (await api.invoke('session:list', { limit: 1 })) as Result<{ id: string }[]>;
    const id = list.value?.[0]?.id;
    if (!id) return '';
    return JSON.stringify(await api.invoke('session:open', { sessionId: id }));
  });
}

/** Mémoire du projet `name`, lue par l'IPC (`project:list`, puis `project:memory`). */
async function projectMemory(page: Page, name: string): Promise<string> {
  return page.evaluate(async (projectName) => {
    type Result<T> = { ok: boolean; value?: T };
    const api = (
      window as unknown as { atelier: { invoke: (c: string, r?: unknown) => Promise<unknown> } }
    ).atelier;
    const list = (await api.invoke('project:list', {})) as Result<{ id: string; name: string }[]>;
    const id = list.value?.find((p) => p.name === projectName)?.id;
    if (!id) return '';
    const memory = (await api.invoke('project:memory', { id })) as Result<{ content: string }>;
    return memory.value?.content ?? '';
  }, name);
}

const execFileAsync = promisify(execFile);

/** Commande dans la VM de l'app (utilisateur par défaut de Lima) : code de sortie et sortie. */
async function inVm(command: string[]): Promise<{ code: number; output: string }> {
  const limactl = join(DESKTOP_DIR, 'resources', 'lima', 'bin', 'limactl');
  try {
    const { stdout, stderr } = await execFileAsync(
      limactl,
      ['shell', '--workdir', '/', 'atelier', '--', ...command],
      { env: { ...process.env, LIMA_HOME: chooseLimaHome('atelier') }, timeout: 60_000 },
    );
    return { code: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim(),
    };
  }
}

/** Constats du scénario, joints au rapport même si une étape échoue. */
interface Findings {
  nestedRefusal?: string;
  conversationSeconds?: number;
  approvals: string[];
  calls?: string;
  skillLoaded?: boolean;
  pages: string[];
  externalUrls: string[];
  localChartLib?: boolean;
  totals: Record<string, boolean>;
  chatCard?: string;
  memory?: string;
  runs: string[][];
  runSeconds: number[];
  pagesAfterRuns?: string[];
  artifactCards: string[];
  versions?: number;
  vmArchives?: { code: number; output: string };
  vmWorkspace?: { code: number; output: string };
}

test('tableau de bord hebdo : projet, artefact, mémoire, tâche et lecture seule avec Qwen', async ({
  atelier,
}, testInfo) => {
  test.setTimeout(4 * TURN_TIMEOUT);
  const { app, page, workspace, root, logs } = atelier;
  const archives = join(root, 'Archives');
  await mkdir(join(archives, '2024'), { recursive: true });
  await writeFile(join(archives, 'bilan-2025.md'), '# Bilan 2025\n\nArchive en lecture seule.\n');
  const found: Findings = {
    approvals: [],
    pages: [],
    externalUrls: [],
    totals: {},
    runs: [],
    runSeconds: [],
    artifactCards: [],
  };
  let dump = '';

  try {
    // 1. Projet « Ventes » : le dossier de travail comme principal, « Archives » en lecture seule.
    const nav = await sidebar(page);
    await nav.getByRole('button', { name: 'Nouveau projet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouveau projet' });
    await dialog.getByRole('textbox', { name: 'Nom' }).fill('Ventes');
    await dialog.getByRole('radio', { name: /Utiliser un dossier existant/ }).check();
    await nextChosenFolder(app, workspace);
    await dialog.getByRole('button', { name: 'Choisir…' }).click();
    await nextChosenFolder(app, archives);
    await dialog.getByRole('button', { name: 'Ajouter un dossier' }).click();
    await dialog.getByRole('combobox', { name: 'Accès au dossier Archives' }).selectOption('read');
    await dialog.getByRole('button', { name: 'Créer le projet' }).click();
    await projectPage(page);

    // 2. Imbrication refusée : un sous-dossier d'« Archives » ne peut pas s'ajouter.
    //    (Le parent du dossier de travail contient aussi le dossier des skills du test :
    //    il serait refusé pour une autre raison, d'où le sous-dossier.)
    await page.getByRole('tab', { name: 'Dossiers' }).click();
    await nextChosenFolder(app, join(archives, '2024'));
    await page.getByRole('button', { name: 'Ajouter un dossier' }).click();
    await page.getByRole('button', { name: 'Enregistrer les dossiers' }).click();
    const refusal = page.getByRole('alert');
    await expect(refusal).toContainText('est déjà inclus dans « Archives »');
    found.nestedRefusal = (await refusal.innerText()).trim();

    // 3. Conversation du projet, avec le vrai modèle. La conversation monte les
    //    dossiers du projet dans la VM : on attend qu'elle soit prête.
    await page.getByRole('button', { name: 'Nouvelle conversation dans le projet' }).click();
    await expect(page.getByTitle('Ouvrir le projet « Ventes »')).toBeVisible();
    if (IS_REAL) await waitForSandbox(page);
    const approvals = autoApprove(page, workspace);
    const started = Date.now();
    await send(page, PROMPT);
    await waitForTurnEnd(page);
    await approvals.stop();
    found.conversationSeconds = Math.round((Date.now() - started) / 1_000);
    found.approvals = approvals.records.map((r) => r.title);
    found.calls = describeCalls(await sessionToolCalls(page));
    dump = await sessionDump(page);
    found.skillLoaded =
      dump.includes('skill artefact-html') ||
      logs.some((l) => l.includes('skill-autoload') && l.includes('artefact-html'));
    found.pages = (await listFiles(workspace)).filter((f) => ARTIFACT_PAGE.test(f));
    const html = found.pages[0] ? await readFile(join(workspace, found.pages[0]), 'utf8') : '';
    found.externalUrls = [...html.matchAll(/(?:src|href)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)].map(
      (m) => m[1] ?? '',
    );
    found.localChartLib = html.includes('atelier-artifact://lib/');
    const numbers = amounts(html);
    found.totals = Object.fromEntries(
      Object.entries(TOTALS).map(([store, total]) => [
        store,
        numbers.some((n) => Math.abs(n - total) < 0.01),
      ]),
    );
    const card = page.getByRole('button', { name: /Ouvrir l’artefact « .+ » \(version \d+\)/ });
    found.chatCard =
      (await card.count()) > 0 ? (await card.first().innerText()).replace(/\s+/g, ' ') : '';
    await page.screenshot({ path: testInfo.outputPath('conversation.png') });

    // Mémoire : la note retenue (avec accord) est visible dans la page du projet.
    await page.getByTitle('Ouvrir le projet « Ventes »').click();
    await projectPage(page);
    await page.getByRole('tab', { name: 'Mémoire et consignes' }).click();
    await expect(page.getByText('Mémoire du projet', { exact: true })).toBeVisible();
    found.memory = await projectMemory(page, 'Ventes');
    await page.screenshot({ path: testInfo.outputPath('memoire.png') });

    // 4. Tâche du projet « Tableau hebdo », exécutée deux fois.
    await page.getByRole('tab', { name: 'Tâches' }).click();
    await page.getByRole('button', { name: 'Nouvelle tâche' }).click();
    await expect(page.getByRole('combobox', { name: 'Projet' })).toHaveValue(/.+/);
    await page.getByRole('textbox', { name: 'Nom' }).fill('Tableau hebdo');
    await page.getByRole('textbox', { name: 'Demande' }).fill(TASK_PROMPT);
    await page.getByRole('combobox', { name: 'Fréquence' }).selectOption('weekly');
    await page.getByRole('textbox', { name: 'Heure' }).fill('08:00');
    await expect(
      page.getByRole('checkbox', {
        name: 'Créer et modifier des fichiers dans les dossiers du projet',
      }),
    ).toBeChecked();
    await page
      .getByRole('checkbox', { name: 'Exécuter des commandes dans la machine isolée' })
      .check();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tâches planifiées' })).toBeVisible();
    await page
      .getByRole('button', { name: 'Plus tard' })
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    const runs = page.getByRole('region', { name: 'Dernières exécutions' });
    for (const expected of [1, 2]) {
      const runStarted = Date.now();
      await page.getByRole('button', { name: 'Exécuter « Tableau hebdo » maintenant' }).click();
      const rows = runs.getByRole('row').filter({ hasText: 'Tableau hebdo' });
      await expect(rows).toHaveCount(expected);
      await expect(rows.first()).not.toContainText(/En file|En cours/, { timeout: TURN_TIMEOUT });
      found.runs.push((await rows.first().getByRole('cell').allInnerTexts()).map((t) => t.trim()));
      found.runSeconds.push(Math.round((Date.now() - runStarted) / 1_000));
    }

    // 5. Artefacts : la même page republiée (v1 par la conversation, puis v2 et v3).
    found.pagesAfterRuns = (await listFiles(workspace)).filter((f) => ARTIFACT_PAGE.test(f));
    await (await sidebar(page)).getByRole('button', { name: 'Ventes', exact: true }).click();
    await projectPage(page);
    await page.getByRole('tab', { name: 'Artefacts' }).click();
    const cards = page.getByRole('button', { name: /Ouvrir l’artefact/ });
    if ((await cards.count()) > 0) {
      found.artifactCards = (await cards.allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
      await cards.first().click();
      found.versions = await page
        .getByRole('combobox', { name: 'Version affichée' })
        .getByRole('option')
        .count();
      await page.screenshot({ path: testInfo.outputPath('artefact.png') });
    }

    // 6. Dans la VM : « Archives » est monté en lecture seule, le principal en écriture.
    if (IS_REAL) {
      found.vmArchives = await inVm(['touch', '/dossiers/Archives/essai']);
      found.vmWorkspace = await inVm(['touch', '/workspace/essai-vm']);
    }
  } finally {
    console.log(`[projets-reel] ${JSON.stringify(found, null, 2)}`);
    await testInfo.attach('projets-reel', {
      body: JSON.stringify(found, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('conversation', { body: dump, contentType: 'application/json' });
  }

  // Contrôles stricts : ce que l'app garantit.
  expect(found.vmArchives?.code, 'touch dans /dossiers/Archives').not.toBe(0);
  expect(found.vmArchives?.output).toMatch(/Read-only file system/);
  expect(found.vmWorkspace?.code, 'touch dans /workspace').toBe(0);
  expect(found.runs, 'deux runs').toHaveLength(2);
  for (const cells of found.runs) expect(cells.join(' '), 'statut du run').toContain('Réussi');

  // Contrôles souples : ce qui dépend du modèle.
  expect.soft(found.skillLoaded, 'skill artefact-html chargé').toBe(true);
  expect.soft(found.pages, 'page écrite dans Artefacts/').toHaveLength(1);
  expect.soft(found.chatCard, 'carte « Artefact publié » dans le chat').not.toBe('');
  expect.soft(found.externalUrls, 'page autonome, sans ressource https').toEqual([]);
  expect.soft(found.localChartLib, 'Chart.js servi par atelier-artifact://lib/').toBe(true);
  expect.soft(found.totals, 'totaux justes au centime').toEqual({
    Bruxelles: true,
    Liège: true,
    Namur: true,
  });
  expect
    .soft(
      found.approvals.some((t) => t.startsWith('Retenir dans la mémoire du projet')),
      'modale memory_write',
    )
    .toBe(true);
  expect.soft(found.memory ?? '', 'note en mémoire').toMatch(/synth[eè]se mensuelle/i);
  expect
    .soft(found.pagesAfterRuns, 'même fichier republié, aucun nouveau fichier')
    .toEqual(found.pages);
  expect.soft(found.versions, 'v1 (conversation), v2 et v3 (runs)').toBe(3);
});
