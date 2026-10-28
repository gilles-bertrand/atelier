import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { PermissionDecision, PermissionHandler, ToolExecutionContext } from '@atelier/shared';

/** Contenu d'une fixture de `test/fixtures`. */
export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

/** Contexte d'exécution d'outil minimal, avec un gestionnaire de permission espionné. */
export function makeContext(decision: PermissionDecision | PermissionHandler = 'allow_once'): {
  context: ToolExecutionContext;
  requestPermission: ReturnType<typeof vi.fn<PermissionHandler>>;
  controller: AbortController;
} {
  const controller = new AbortController();
  const requestPermission = vi.fn<PermissionHandler>(
    typeof decision === 'function' ? decision : () => Promise.resolve(decision),
  );
  return {
    controller,
    requestPermission,
    context: {
      sessionId: 'session-1',
      toolCallId: 'call-1',
      workspace: '/tmp/atelier-test',
      abortSignal: controller.signal,
      requestPermission,
    },
  };
}
