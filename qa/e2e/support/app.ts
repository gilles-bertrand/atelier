/**
 * Lancement d'Atelier pour les e2e : `userData` et dossier de travail
 * temporaires, réglages pré-remplis (onboarding fait), boîte de dialogue
 * « Choisir un dossier » remplacée, et aides pour piloter le chat.
 *
 * Deux modes (variable `ATELIER_E2E_MODE`) :
 * - `mock` (défaut, CI) : faux serveur LLM local (`mock-llm.ts`), pas de VM ;
 * - `real` (local) : Ollama (`ATELIER_E2E_LLM_URL`, défaut http://localhost:11434,
 *   modèle `ATELIER_E2E_MODEL`, défaut `atelier`) et la VM Lima de l'app.
 */
import { cp, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export type E2eMode = 'mock' | 'real';
export const MODE: E2eMode = process.env['ATELIER_E2E_MODE'] === 'real' ? 'real' : 'mock';
export const IS_REAL = MODE === 'real';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

/** Durées maximales d'un tour : un vrai modèle 35b + VM est lent. */
export const TURN_TIMEOUT = IS_REAL ? 15 * 60_000 : 30_000;

export interface LaunchOptions {
  /** URL du serveur LLM (faux serveur en mode mock). */
  llmUrl: string;
  model: string;
  thinking?: boolean;
  /** Fichiers ou dossiers copiés dans le dossier de travail. */
  seed?: string[];
  /** Démarre l'app sur un `userData` vierge (onboarding), pour mesurer le premier lancement. */
  fresh?: boolean;
}

export interface AtelierApp {
  app: ElectronApplication;
  page: Page;
  workspace: string;
  userData: string;
  /** Journal du process main (stdout + stderr). */
  logs: string[];
  close: () => Promise<void>;
}

export async function launchAtelier(options: LaunchOptions): Promise<AtelierApp> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atelier-e2e-')));
  const userData = join(root, 'userData');
  const workspace = join(root, 'workspace');
  const skillsDir = join(root, 'skills');
  await mkdir(userData, { recursive: true });
  await mkdir(workspace, { recursive: true });
  for (const source of options.seed ?? []) {
    await cp(source, workspace, { recursive: true });
  }
  if (!options.fresh) {
    await writeFile(
      join(userData, 'settings.json'),
      JSON.stringify(
        {
          llm: {
            baseUrl: options.llmUrl,
            model: options.model,
            thinking: options.thinking ?? false,
          },
          sandbox: { cpus: 4, memoryGiB: 4, diskGiB: 30, networkEnabledByDefault: false },
          search: { provider: 'searxng' },
          skillsDir,
          mcpConfigPath: join(root, 'mcp.json'),
          onboardingCompleted: true,
          privacyAcceptedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  const main = join(DESKTOP_DIR, 'out', 'main', 'index.js');
  if (!existsSync(main)) {
    throw new Error(
      `App non construite (${main}) : lancez « pnpm --filter @atelier/desktop build ».`,
    );
  }
  const logs: string[] = [];
  const executable = process.env['ATELIER_E2E_EXECUTABLE'];
  const app = await electron.launch({
    // Mock : on lance le script main directement. `app.getAppPath()` vaut alors
    // `out/main`, où `limactl` n'existe pas : jamais de VM, même dans un checkout
    // où `pnpm fetch:lima` a été lancé (la VM locale n'est pas touchée).
    // Réel : l'app du dépôt (ou l'app packagée, ATELIER_E2E_EXECUTABLE).
    args: [...(executable ? [] : [IS_REAL ? DESKTOP_DIR : main]), `--user-data-dir=${userData}`],
    ...(executable ? { executablePath: executable } : {}),
    cwd: DESKTOP_DIR,
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_RENDERER_URL: '' },
    timeout: 60_000,
  });
  app.process().stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  app.process().stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

  // « Choisir un dossier » : la boîte de dialogue native renvoie le dossier de test.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
  }, workspace);

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Diagnostic : un plantage ou une fermeture inattendue apparaît dans main.log.
  const stamp = (): string => new Date().toISOString().slice(11, 23);
  page.on('crash', () => logs.push(`[e2e ${stamp()}] plantage du renderer\n`));
  page.on('close', () => logs.push(`[e2e ${stamp()}] fenêtre fermée\n`));
  page.on('pageerror', (error) =>
    logs.push(`[e2e ${stamp()}] erreur renderer : ${error.message}\n`),
  );
  app.on('close', () => logs.push(`[e2e ${stamp()}] process Electron terminé\n`));

  return {
    app,
    page,
    workspace,
    userData,
    logs,
    close: async () => {
      await app.close().catch(() => undefined);
      if (process.env['ATELIER_E2E_KEEP'] !== '1') {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** Ouvre une nouvelle conversation sur le dossier de travail de test. */
export async function openWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Choisir un dossier' }).click();
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeVisible();
}

export async function send(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Votre message' });
  await box.fill(text);
  await page.getByRole('button', { name: 'Envoyer' }).click();
  // Pas d'attente sur « Arrêter » : avec un modèle rapide (mock en CI), le tour peut
  // déjà être fini. Le message envoyé apparaît dans la conversation dans tous les cas.
  await expect(
    page.getByRole('log', { name: 'Conversation' }).getByText(text, { exact: true }).first(),
  ).toBeVisible();
}

/**
 * Attend la fin du tour : aucune demande de permission ouverte et le bouton
 * « Envoyer » de retour, de façon stable pendant 2 s. Une simple attente sur
 * « Arrêter » masqué ne suffit pas : pendant une modale de permission, le reste
 * de la page sort de l'arbre d'accessibilité et le bouton paraît masqué.
 */
export async function waitForTurnEnd(page: Page, timeout = TURN_TIMEOUT): Promise<void> {
  const idle = async (): Promise<boolean> =>
    (await page.getByRole('alertdialog').count()) === 0 &&
    (await page.getByRole('button', { name: 'Arrêter', exact: true }).count()) === 0 &&
    (await page.getByRole('button', { name: 'Envoyer', exact: true }).count()) === 1;
  const deadline = Date.now() + timeout;
  let stableSince: number | undefined;
  while (Date.now() < deadline) {
    if (await idle()) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 2_000) return;
    } else {
      stableSince = undefined;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Tour non terminé après ${String(timeout)} ms`);
}

export interface PermissionRecord {
  title: string;
  description: string;
  at: number;
  /** Fichiers du dossier de travail au moment de la demande. */
  filesBefore: string[];
}

/**
 * Accepte (« Autoriser une fois ») chaque demande de permission tant que le
 * tour tourne, et journalise la demande avec l'état du dossier à cet instant :
 * de quoi vérifier qu'une écriture est demandée AVANT d'avoir lieu.
 */
export function autoApprove(
  page: Page,
  workspace: string,
  decide: (title: string) => 'Autoriser une fois' | 'Refuser' = () => 'Autoriser une fois',
): { records: PermissionRecord[]; stop: () => Promise<void> } {
  const records: PermissionRecord[] = [];
  const state = { running: true };
  const loop = (async () => {
    const dialog = page.getByRole('alertdialog');
    while (state.running) {
      try {
        await dialog.waitFor({ state: 'visible', timeout: 500 });
      } catch {
        continue;
      }
      const title = (await dialog.getByRole('heading').first().textContent()) ?? '';
      const description = (await dialog.textContent()) ?? '';
      records.push({ title, description, at: Date.now(), filesBefore: await listFiles(workspace) });
      await dialog.getByRole('button', { name: decide(title) }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    }
  })().catch(() => undefined);
  return {
    records,
    stop: async () => {
      state.running = false;
      await loop;
    },
  };
}

/** Fichiers du dossier (récursif, sans `.atelier/`), chemins relatifs. */
export async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === '.atelier') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** Bloc d'outil du chat dont le libellé contient `label` (ex. « Lecture de ventes-liege.csv »). */
export function toolBlock(page: Page, label: string | RegExp) {
  return page
    .getByRole('log', { name: 'Conversation' })
    .locator('details > summary')
    .filter({ hasText: label });
}

/** Carte de fichier (chat ou panneau) : repérée par son bouton Finder. */
export function fileCard(page: Page, name: string) {
  return page.getByRole('button', { name: `Afficher ${name} dans le Finder` });
}

/** Texte de la dernière réponse de l'assistant. */
export async function conversationText(page: Page): Promise<string> {
  return (await page.getByRole('log', { name: 'Conversation' }).textContent()) ?? '';
}

/** État de la VM vu par le renderer (canal `sandbox:status`). */
export async function sandboxStatus(
  page: Page,
): Promise<{ state: string; workspace?: string; networkEnabled: boolean }> {
  return page.evaluate(async () => {
    const api = (window as unknown as { atelier: { invoke: (c: string) => Promise<unknown> } })
      .atelier;
    const result = (await api.invoke('sandbox:status')) as {
      ok: boolean;
      value?: { state: string; workspace?: string; networkEnabled: boolean };
    };
    return result.value ?? { state: 'unknown', networkEnabled: false };
  });
}

/** Attend que la VM soit prête (mode réel). */
export async function waitForSandbox(page: Page, timeout = 15 * 60_000): Promise<void> {
  await expect
    .poll(async () => (await sandboxStatus(page)).state, {
      timeout,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBe('ready');
}

/**
 * Dépose des fichiers dans le chat comme depuis le Finder : un vrai glisser-
 * déposer Chromium (CDP `Input.dispatchDragEvent`) avec des chemins disque,
 * pour que `webUtils.getPathForFile` les résolve.
 */
export async function dropFiles(page: Page, paths: string[]): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const box = await page.getByRole('textbox', { name: 'Votre message' }).boundingBox();
  if (!box) throw new Error('Zone de saisie introuvable');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
    await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
  }
  await cdp.detach();
}

export interface ToolCallRecord {
  toolName: string;
  input: Record<string, unknown>;
  status: string;
  output?: string;
}

/** Appels d'outils de la conversation la plus récente (historique persistant, `session:open`). */
export async function sessionToolCalls(page: Page): Promise<ToolCallRecord[]> {
  return page.evaluate(async () => {
    type Result<T> = { ok: boolean; value?: T };
    const api = (
      window as unknown as { atelier: { invoke: (c: string, r?: unknown) => Promise<unknown> } }
    ).atelier;
    const list = (await api.invoke('session:list', { limit: 1 })) as Result<{ id: string }[]>;
    const id = list.value?.[0]?.id;
    if (!id) return [];
    const opened = (await api.invoke('session:open', { sessionId: id })) as Result<{
      messages: {
        parts?: {
          type: string;
          toolName?: string;
          input?: unknown;
          status?: string;
          output?: string;
        }[];
      }[];
    }>;
    const calls: {
      toolName: string;
      input: Record<string, unknown>;
      status: string;
      output?: string;
    }[] = [];
    for (const message of opened.value?.messages ?? []) {
      for (const part of message.parts ?? []) {
        if (part.type !== 'tool_call') continue;
        calls.push({
          toolName: part.toolName ?? '?',
          input: (part.input ?? {}) as Record<string, unknown>,
          status: part.status ?? '?',
          ...(part.output !== undefined ? { output: part.output } : {}),
        });
      }
    }
    return calls;
  });
}

/** Résumé lisible des appels d'outils, joint au rapport en cas d'échec. */
export function describeCalls(calls: ToolCallRecord[]): string {
  return calls
    .map((c) => `${c.status.padEnd(9)} ${c.toolName} ${JSON.stringify(c.input).slice(0, 200)}`)
    .join('\n');
}

/** Texte des réponses de l'assistant (sans les sorties d'outils) de la conversation la plus récente. */
export async function assistantText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    type Result<T> = { ok: boolean; value?: T };
    const api = (
      window as unknown as { atelier: { invoke: (c: string, r?: unknown) => Promise<unknown> } }
    ).atelier;
    const list = (await api.invoke('session:list', { limit: 1 })) as Result<{ id: string }[]>;
    const id = list.value?.[0]?.id;
    if (!id) return '';
    const opened = (await api.invoke('session:open', { sessionId: id })) as Result<{
      messages: { role: string; parts?: { type: string; text?: string }[] }[];
    }>;
    return (opened.value?.messages ?? [])
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? ''))
      .join('\n');
  });
}
