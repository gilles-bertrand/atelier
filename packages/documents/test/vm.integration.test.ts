/**
 * Rendu réel des pages PDF par `pdftoppm` dans la VM Lima (skippé par défaut).
 *
 *   ATELIER_SANDBOX_IT=1 pnpm --filter @atelier/documents test vm.integration
 *
 * Réutilise l'instance `atelier-it` des tests d'intégration de `@atelier/sandbox`
 * (prérequis : `pnpm fetch:lima` ; premier lancement long si la VM n'existe pas).
 * Le modèle vision est simulé, sauf avec `ATELIER_DOCUMENTS_IT=1` (voir
 * vision.integration.test.ts pour les variables du serveur LLM).
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLlmModels } from '@atelier/agent-core';
import { LimaSandbox } from '@atelier/sandbox';
import {
  createLookAtTool,
  createReadFileTool,
  createVisionAnalyzer,
  PAGES_DIR,
  renderPdfPage,
  sha256,
} from '../src/index.js';
import { contextFor, FIXTURES, okContent, visionModel } from './helpers.js';

const enabled =
  process.platform === 'darwin' &&
  process.arch === 'arm64' &&
  process.env['ATELIER_SANDBOX_IT'] === '1';
const realVision = process.env['ATELIER_DOCUMENTS_IT'] === '1';

const REPO = resolve(import.meta.dirname, '../../..');
const MINUTE = 60_000;

describe.skipIf(!enabled)('pdftoppm dans une vraie VM Lima', () => {
  let sandbox: LimaSandbox;
  let root: string;
  let workspace: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-docs-it-')));
    workspace = join(root, 'projet');
    await mkdir(workspace);
    await mkdir(join(root, 'skills'));
    await copyFile(join(FIXTURES, 'scan.pdf'), join(workspace, "facture l'été.pdf"));
    sandbox = new LimaSandbox({
      limactlPath: join(REPO, 'apps/desktop/resources/lima/bin/limactl'),
      templatesDir: join(REPO, 'lima'),
      limaHome:
        process.env['ATELIER_SANDBOX_IT_LIMA_HOME'] ??
        join(homedir(), 'Library', 'Application Support', 'Atelier', 'lima-it'),
      instanceName: 'atelier-it',
      skillsDir: join(root, 'skills'),
    });
    await sandbox.setWorkspace(workspace);
    await sandbox.ensureReady();
  }, 30 * MINUTE);

  afterAll(async () => {
    await sandbox.stop();
    await rm(root, { recursive: true, force: true });
  }, 2 * MINUTE);

  it('rend deux fois la page scannée en PNG (1568 px de haut), sans laisser de fichier', async () => {
    const data = await readFile(join(workspace, "facture l'été.pdf"));
    for (let i = 0; i < 2; i++) {
      // Deux rendus de suite : vérifie qu'aucun nom n'est réutilisé (cache virtiofs).
      const png = await renderPdfPage({
        sandbox,
        workspace,
        relativePath: "facture l'été.pdf",
        fileHash: sha256(data),
        page: 2,
      });
      const meta = await sharp(png).metadata();
      expect(meta.format).toBe('png');
      expect(Math.max(meta.width, meta.height)).toBe(1568);
    }
    expect(await readdir(join(workspace, PAGES_DIR))).toEqual([]);
  });

  it('read_file et look_at passent par la VM puis la vision', { timeout: 5 * MINUTE }, async () => {
    const model = realVision
      ? createLlmModels({
          baseUrl: process.env['ATELIER_LLM_URL'] ?? 'http://localhost:11434',
          model: process.env['ATELIER_LLM_MODEL'] ?? 'qwen3.5:9b',
          token: process.env['ATELIER_LLM_TOKEN'] ?? '',
          thinking: false,
        }).model
      : visionModel('FACTURE N° 2026-117\nTotal TTC : 1 234,56 EUR');
    const vision = createVisionAnalyzer({ model });
    const ctx = contextFor(workspace, { sandbox });
    const read = okContent(
      await createReadFileTool({ vision, cache: false }).execute(
        { path: "facture l'été.pdf" },
        ctx,
      ),
    );
    console.info(read);
    expect(read).toMatch(/--- page 2 \(scannée, transcrite par le modèle vision\) ---/);
    expect(read).toMatch(/2026-117/);
    const answer = okContent(
      await createLookAtTool({ vision, cache: false }).execute(
        { path: "facture l'été.pdf", page: 2, question: 'Quel est le total TTC ?' },
        ctx,
      ),
    );
    console.info(answer);
    expect(answer).toMatch(/1[  ]?234[,.]56/);
  });
});
