/**
 * Critère d'acceptation 2 (docs/BRIEF.md) : sur un dossier de 3 CSV de ventes,
 * « Fais-moi un Excel récapitulatif par mois avec un graphique, puis un résumé
 * en markdown » doit créer une liste de tâches visible, lire les CSV, utiliser
 * le skill xlsx dans la VM, demander la permission avant d'écrire et produire
 * recap.xlsx + resume.md en cartes cliquables.
 *
 * Mock : le faux modèle joue la séquence attendue, sans VM (le skill ne peut
 * pas tourner : on vérifie l'appel). Réel : qwen3.5 + VM, et le contenu du
 * classeur (totaux mensuels, graphique) est contrôlé.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  autoApprove,
  describeCalls,
  fileCard,
  FIXTURES_DIR,
  IS_REAL,
  listFiles,
  openWorkspace,
  send,
  sessionToolCalls,
  waitForSandbox,
  waitForTurnEnd,
} from './support/app.js';
import { expect, test } from './support/fixture.js';
import { GRAND_TOTAL, MONTHLY_TOTALS, PROMPTS } from './support/scenarios.js';

test.use({ seed: [join(FIXTURES_DIR, 'demo-ventes')] });

const CSV = ['ventes-bruxelles.csv', 'ventes-liege.csv', 'ventes-namur.csv'];

test('critère 2 : Excel récapitulatif par mois + résumé markdown', async ({
  atelier,
}, testInfo) => {
  const { page, workspace } = atelier;
  await openWorkspace(page);
  if (IS_REAL) await waitForSandbox(page);

  const permissions = autoApprove(page, workspace);
  await send(page, PROMPTS.excel);
  await waitForTurnEnd(page);
  await permissions.stop();

  const calls = await sessionToolCalls(page);
  await testInfo.attach('tool-calls.txt', {
    body: describeCalls(calls),
    contentType: 'text/plain',
  });
  await testInfo.attach('permissions.json', {
    body: JSON.stringify(permissions.records, null, 2),
    contentType: 'application/json',
  });

  // 1. Une liste de tâches visible dans le panneau de suivi.
  const panel = page.getByRole('complementary', { name: 'Suivi de la conversation' });
  await expect(
    panel.getByRole('region', { name: 'Tâches' }).getByRole('listitem').first(),
  ).toBeVisible();
  expect(calls.some((c) => c.toolName === 'todo_write')).toBe(true);

  // 2. Les 3 CSV sont lus (read_file, ou un script dans la VM qui les ouvre).
  for (const csv of CSV) {
    const read = calls.some((c) => {
      if (c.toolName === 'read_file') return String(c.input['path']).endsWith(csv);
      if (c.toolName !== 'bash' && c.toolName !== 'write_file') return false;
      // Un script Python/Node qui ouvre le fichier par son nom ou par motif.
      const code = JSON.stringify(c.input);
      return code.includes(csv) || /\*\.csv|ventes-\*|glob\(/.test(code);
    });
    expect(read, `${csv} doit être lu`).toBe(true);
  }

  // 3. Le skill xlsx est lancé dans la VM.
  const skillRun = calls.find(
    (c) => c.toolName === 'bash' && String(c.input['command']).includes('/skills/xlsx/'),
  );
  expect(skillRun, 'le script du skill xlsx doit être lancé via bash').toBeDefined();

  // Le brief cite recap.xlsx et resume.md, mais la demande ne nomme pas les fichiers :
  // on accepte tout nouveau classeur et tout nouveau markdown.
  const created = (await listFiles(workspace)).filter((f) => !CSV.includes(f));
  const resumeName = created.find((f) => f.endsWith('.md'));
  expect(resumeName, `aucun résumé markdown créé (fichiers : ${created.join(', ')})`).toBeDefined();
  const resumeFile = resumeName ?? 'resume.md';

  // 4. Permission demandée AVANT chaque écriture : le résumé n'existait pas à la demande.
  const resumeAsk = permissions.records.find((r) => r.description.includes(resumeFile));
  expect(resumeAsk, `une permission doit être demandée pour écrire ${resumeFile}`).toBeDefined();
  expect(resumeAsk?.filesBefore).not.toContain(resumeFile);
  for (const write of calls.filter(
    (c) => c.toolName === 'write_file' || c.toolName === 'edit_file',
  )) {
    expect(write.status, `écriture sans permission ? ${JSON.stringify(write.input)}`).not.toBe(
      'running',
    );
  }

  // 5. Cartes de fichier cliquables.
  await expect(fileCard(page, basename(resumeFile)).first()).toBeVisible();
  const resume = await readFile(join(workspace, resumeFile), 'utf8');
  expect(resume.length).toBeGreaterThan(50);

  if (!IS_REAL) {
    // Sans VM, le skill ne peut pas tourner : l'erreur est rendue au modèle, pas d'exception.
    expect(skillRun?.status).toBe('error');
    expect(skillRun?.output).toMatch(/machine virtuelle/);
    return;
  }

  // --- Mode réel : le classeur lui-même.
  expect(skillRun?.status).toBe('success');
  const xlsxName = created.find((f) => f.endsWith('.xlsx'));
  expect(xlsxName, `aucun classeur créé (fichiers : ${created.join(', ')})`).toBeDefined();
  const xlsxPath = join(workspace, xlsxName ?? 'recap.xlsx');
  expect((await stat(xlsxPath)).size).toBeGreaterThan(1000);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const numbers: number[] = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        const v = cell.value;
        if (typeof v === 'number') numbers.push(v);
        else if (v && typeof v === 'object' && 'result' in v && typeof v.result === 'number')
          numbers.push(v.result);
      });
    });
  });
  const near = (target: number): boolean => numbers.some((n) => Math.abs(n - target) < 0.05);
  for (const [month, total] of Object.entries(MONTHLY_TOTALS)) {
    expect(near(total), `total ${month} (${total}) absent du classeur`).toBe(true);
  }
  // Graphique Excel natif présent dans le paquet OOXML.
  const zip = await JSZip.loadAsync(await readFile(xlsxPath));
  expect(Object.keys(zip.files).some((f) => /^xl\/charts\/chart\d+\.xml$/.test(f))).toBe(true);
  // Le classeur, produit dans la VM, doit lui aussi apparaître en carte cliquable.
  await expect(fileCard(page, basename(xlsxPath)).first()).toBeVisible();
  // Le résumé reprend le total général.
  expect(resume.replace(/[\s\u00a0\u202f]/g, '')).toMatch(/89[.,]?237[.,]1/);
  expect(GRAND_TOTAL).toBe(89_237.1);
});
