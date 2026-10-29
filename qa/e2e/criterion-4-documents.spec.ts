/**
 * Critère d'acceptation 4 (docs/BRIEF.md) : un PDF de 30 pages, une facture
 * PDF scannée et une photo de ticket glissés dans le chat ; « Résume le
 * rapport et fais un tableau des montants de la facture et du ticket » lit le
 * PDF par tranches de pages, passe la facture et le ticket par le modèle
 * vision et produit un tableau correct.
 *
 * Mock : la facture scannée ne peut pas être rendue sans VM (pdftoppm tourne
 * dans la VM) ; le ticket passe bien par la vision (requête image reçue par le
 * faux serveur). Réel : qwen3.5 (vision native) + VM, montants contrôlés.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  autoApprove,
  conversationText,
  describeCalls,
  dropFiles,
  FIXTURES_DIR,
  IS_REAL,
  openWorkspace,
  send,
  sessionToolCalls,
  waitForSandbox,
  waitForTurnEnd,
} from './support/app.js';
import { expect, test } from './support/fixture.js';
import { PROMPTS } from './support/scenarios.js';

const DOCS = ['rapport-annuel-2025.pdf', 'facture-scannee.pdf', 'ticket-de-caisse.jpg'];

/** Pages couvertes par un paramètre `pages` (« 1-10 », « 3 », « 1-5,8 »). */
function pagesOf(spec: unknown): number[] {
  if (typeof spec !== 'string') return [];
  return spec.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map((n) => Number.parseInt(n.trim(), 10));
    if (a === undefined || Number.isNaN(a)) return [];
    const end = b === undefined || Number.isNaN(b) ? a : b;
    return Array.from({ length: end - a + 1 }, (_, i) => a + i);
  });
}

/**
 * Pages réellement renvoyées par un `read_file` PDF, lues dans l'en-tête de sa sortie
 * (`[PDF : …, 30 pages au total ; pages 1-11 ci-dessous …]`). Une lecture sans
 * `pages` renvoie une première tranche : elle compte aussi.
 */
function pagesShown(output: string | undefined): number[] {
  const match = /pages ([\d,\s-]+) ci-dessous/.exec(output ?? '');
  return pagesOf(match?.[1]?.replace(/\s/g, ''));
}

test('critère 4 : rapport par tranches, facture et ticket par la vision, tableau des montants', async ({
  atelier,
  llm,
}, testInfo) => {
  const { page, workspace } = atelier;
  await openWorkspace(page);
  if (IS_REAL) await waitForSandbox(page);

  // Glisser-déposer depuis le Finder : vignettes dans la zone de saisie.
  await dropFiles(
    page,
    DOCS.map((name) => join(FIXTURES_DIR, 'demo-documents', name)),
  );
  const attachments = page.getByRole('list', { name: 'Pièces jointes' });
  for (const name of DOCS) await expect(attachments.getByText(name)).toBeVisible();
  for (const name of DOCS)
    expect(existsSync(join(workspace, '.atelier', 'uploads', name))).toBe(true);

  const permissions = autoApprove(page, workspace);
  await send(page, PROMPTS.documents);
  await waitForTurnEnd(page);
  await permissions.stop();

  const calls = await sessionToolCalls(page);
  await testInfo.attach('tool-calls.txt', {
    body: describeCalls(calls),
    contentType: 'text/plain',
  });

  // 1. Le rapport est lu par tranches de pages (20 pages max par appel), en entier.
  const reportReads = calls.filter(
    (c) =>
      c.toolName === 'read_file' &&
      c.status === 'success' &&
      String(c.input['path']).includes('rapport-annuel-2025'),
  );
  expect(
    reportReads.length,
    'le rapport doit être lu en plusieurs tranches',
  ).toBeGreaterThanOrEqual(2);
  for (const read of reportReads) expect(pagesShown(read.output).length).toBeLessThanOrEqual(20);
  const covered = new Set(reportReads.flatMap((r) => pagesShown(r.output)));
  expect(covered.size, 'les 30 pages doivent être lues').toBeGreaterThanOrEqual(30);

  // 2. Facture et ticket passent par la vision (look_at, ou read_file qui délègue à la vision).
  const visual = (name: string) =>
    calls.filter(
      (c) =>
        (c.toolName === 'look_at' || c.toolName === 'read_file') &&
        String(c.input['path']).includes(name),
    );
  expect(visual('facture-scannee').length).toBeGreaterThan(0);
  expect(visual('ticket-de-caisse').length).toBeGreaterThan(0);

  const answer = await conversationText(page);
  // Un tableau unique ou un tableau par document : les deux répondent à la demande.
  const tables = page.getByRole('log', { name: 'Conversation' }).getByRole('table');
  await expect(tables.last()).toBeVisible();

  if (!IS_REAL) {
    // Le ticket a bien été envoyé au modèle vision sous forme d'image.
    expect(llm.requests.some((r) => r.vision)).toBe(true);
    const ticket = visual('ticket-de-caisse')[0];
    expect(ticket?.status).toBe('success');
    expect(ticket?.output).toContain('27,50');
    // Facture scannée sans VM : refus explicite, pas de plantage.
    expect(visual('facture-scannee')[0]?.status).toBe('error');
    return;
  }

  // --- Mode réel : la vision a vraiment lu les montants, et le tableau est juste.
  const visionOutputs = [...visual('facture-scannee'), ...visual('ticket-de-caisse')]
    .map((c) => c.output ?? '')
    .join('\n');
  expect(visionOutputs).toMatch(/439[,.]23/);
  expect(visionOutputs).toMatch(/27[,.]50/);
  const tableText = (await tables.allTextContents()).join('\n');
  expect(tableText).toMatch(/439[,.]23/);
  expect(tableText).toMatch(/27[,.]5/);
  for (const amount of [/90[,.]00/, /186[,.]00/, /87[,.]00/, /363[,.]00/, /76[,.]23/]) {
    expect(answer, `montant de la facture manquant : ${String(amount)}`).toMatch(amount);
  }
  // Faits du rapport (un par chapitre dans le PDF) : on en exige au moins deux.
  const facts = [
    /4[,.]2\s*M|4[,.]2 millions/i,
    /54 (personnes|collaborateurs|salariés|employés)/i,
    /238\s*000|238 k/i,
    /4[,.]8\s*M|Mons/i,
  ];
  expect(facts.filter((f) => f.test(answer)).length).toBeGreaterThanOrEqual(2);
});
