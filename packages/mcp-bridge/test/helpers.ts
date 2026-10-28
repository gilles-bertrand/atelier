import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { PermissionHandler, ToolExecutionContext } from '@atelier/shared';

/** Dossier temporaire (chemin réel : /var → /private/var sur macOS). */
export function tempDir(prefix = 'atelier-mcp-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Contexte d'exécution d'outil minimal. */
export function makeContext(): { context: ToolExecutionContext; controller: AbortController } {
  const controller = new AbortController();
  const requestPermission = vi.fn<PermissionHandler>(() => Promise.resolve('allow_once'));
  return {
    controller,
    context: {
      sessionId: 'session-1',
      toolCallId: 'call-1',
      workspace: '/tmp',
      abortSignal: controller.signal,
      requestPermission,
    },
  };
}

/** Attend qu'une condition devienne vraie (polling court). */
export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Délai dépassé en attendant la condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
