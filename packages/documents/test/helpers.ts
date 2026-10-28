import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4 } from 'ai/test';
import {
  GUEST_WORKSPACE,
  type Sandbox,
  type SandboxExecOptions,
  type SandboxExecResult,
  type ToolExecutionContext,
  type ToolOutput,
} from '@atelier/shared';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Crée un dossier de travail temporaire, y copie des fixtures, puis le supprime. */
export async function withWorkspace<T>(
  fixtures: readonly string[],
  fn: (ws: string) => Promise<T>,
): Promise<T> {
  const ws = await mkdtemp(path.join(os.tmpdir(), 'atelier-docs-'));
  try {
    for (const f of fixtures) await copyFile(path.join(FIXTURES, f), path.join(ws, f));
    return await fn(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

export function contextFor(
  workspace: string,
  extra: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    sessionId: 's1',
    toolCallId: 'c1',
    workspace,
    abortSignal: new AbortController().signal,
    requestPermission: () => Promise.resolve('allow_once'),
    ...extra,
  };
}

/** Résultat attendu d'un outil réussi : renvoie son texte. */
export function okContent(output: ToolOutput): string {
  if (!output.ok) throw new Error(`Échec inattendu : ${output.content}`);
  return output.content;
}

interface PromptPart {
  type: string;
  text?: string;
  mediaType?: string;
}

/** Modèle vision simulé : répond `answer`, enregistre les prompts reçus. */
export function visionModel(answer: string | ((prompt: string) => string)): MockLanguageModelV4 & {
  prompts: { text: string; mediaType?: string; system?: string }[];
} {
  const prompts: { text: string; mediaType?: string; system?: string }[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: (options) => {
      let text = '';
      let mediaType: string | undefined;
      let system: string | undefined;
      for (const message of options.prompt) {
        if (message.role === 'system') system = message.content;
        if (message.role !== 'user') continue;
        for (const part of message.content as PromptPart[]) {
          if (part.type === 'text') text += part.text ?? '';
          if (part.type === 'file') mediaType = part.mediaType;
        }
      }
      prompts.push({ text, ...(mediaType ? { mediaType } : {}), ...(system ? { system } : {}) });
      return Promise.resolve({
        content: [{ type: 'text', text: typeof answer === 'string' ? answer : answer(text) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
        },
        warnings: [],
      });
    },
  });
  return Object.assign(model, { prompts });
}

/**
 * Fausse VM : `pdftoppm` y est simulé en copiant `scan-page-2.png` vers la sortie
 * demandée (le dossier de travail est « monté » sur /workspace).
 */
export function fakeSandbox(
  workspace: string,
  behavior: { exitCode?: number; stderr?: string } = {},
): Sandbox & { commands: string[] } {
  const commands: string[] = [];
  const toHost = (guest: string): string | null =>
    guest === GUEST_WORKSPACE || guest.startsWith(`${GUEST_WORKSPACE}/`)
      ? path.join(workspace, guest.slice(GUEST_WORKSPACE.length))
      : null;
  const sandbox: Sandbox & { commands: string[] } = {
    commands,
    ensureReady: () => Promise.resolve(),
    setWorkspace: () => Promise.resolve(),
    async exec(command: string, _options?: SandboxExecOptions): Promise<SandboxExecResult> {
      commands.push(command);
      const base = { stdout: '', truncated: false, timedOut: false, durationMs: 5 };
      if (behavior.exitCode !== undefined && behavior.exitCode !== 0) {
        return { ...base, exitCode: behavior.exitCode, stderr: behavior.stderr ?? '' };
      }
      const args = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
      const prefix = args.at(-1);
      const out = prefix ? toHost(prefix) : null;
      if (command.startsWith('pdftoppm ') && out) {
        await mkdir(path.dirname(out), { recursive: true });
        await copyFile(path.join(FIXTURES, 'scan-page-2.png'), `${out}.png`);
      }
      return { ...base, exitCode: 0, stderr: '' };
    },
    setNetwork: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    status: () => ({ state: 'ready', workspace, networkEnabled: false }),
    diagnostics: () => Promise.resolve({ limaHome: '/tmp', resources: { cpus: 4, memoryGiB: 4 } }),
    toGuestPath: (host: string) => {
      const rel = path.relative(workspace, host);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return rel === '' ? GUEST_WORKSPACE : `${GUEST_WORKSPACE}/${rel.split(path.sep).join('/')}`;
    },
    toHostPath: toHost,
  };
  return sandbox;
}
