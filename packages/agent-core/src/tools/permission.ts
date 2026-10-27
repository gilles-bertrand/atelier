/**
 * Demandes de permission construites par agent-core.
 *
 * Les outils `permission: 'always'` sont protégés génériquement par l'adaptateur
 * (voir `registry.ts`) ; les outils `conditional` (ex. `bash`) appellent
 * {@link askPermission} eux-mêmes dans leur `execute`.
 */
import { randomUUID } from 'node:crypto';
import {
  isAllowed,
  type PermissionDecision,
  type PermissionHandler,
  type PermissionKind,
  type PermissionRequest,
  type ToolExecutionContext,
  type ToolOutput,
} from '@atelier/shared';

/** Partie descriptive d'une demande de permission (le reste est fourni par le contexte). */
export interface PermissionDescription {
  kind: PermissionKind;
  title: string;
  detail?: string;
  scopeKey?: string;
}

/** Produit la description d'une demande de permission pour un appel d'outil. */
export type PermissionDescriber = (toolName: string, input: unknown) => PermissionDescription;

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value: unknown = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function preview(text: string | undefined, max = 2_000): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** Description par défaut : libellés français pour les outils natifs, générique sinon. */
export const defaultDescribePermission: PermissionDescriber = (toolName, input) => {
  const p = field(input, 'path') ?? '';
  switch (toolName) {
    case 'write_file':
      return {
        kind: 'file_write',
        title: `Écrire le fichier ${p}`,
        detail: preview(field(input, 'content')),
        scopeKey: 'write_file',
      };
    case 'edit_file':
      return {
        kind: 'file_write',
        title: `Modifier le fichier ${p}`,
        detail: preview(`- ${field(input, 'old_str') ?? ''}\n+ ${field(input, 'new_str') ?? ''}`),
        scopeKey: 'edit_file',
      };
    case 'bash':
      return {
        kind: 'command',
        title: 'Exécuter une commande',
        detail: field(input, 'command'),
        scopeKey: 'bash',
      };
    default:
      return {
        kind: toolName.startsWith('mcp__') ? 'mcp_write' : 'other',
        title: `Utiliser l'outil ${toolName}`,
        detail: preview(safeJson(input)),
        scopeKey: toolName,
      };
  }
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Construit la demande complète puis interroge le gestionnaire du contexte. */
export async function askPermission(
  context: ToolExecutionContext,
  toolName: string,
  input: unknown,
  description: PermissionDescription,
): Promise<PermissionDecision> {
  const request: PermissionRequest = {
    id: randomUUID(),
    sessionId: context.sessionId,
    toolCallId: context.toolCallId,
    toolName,
    input,
    kind: description.kind,
    title: description.title,
    ...(description.detail !== undefined ? { detail: description.detail } : {}),
    scopeKey: description.scopeKey ?? toolName,
  };
  return context.requestPermission(request, context.abortSignal);
}

/** Sortie d'outil enrichie d'un drapeau de refus (interne à agent-core). */
export interface ExecutedToolOutput extends ToolOutput {
  denied?: boolean;
}

/** Message renvoyé au modèle quand l'utilisateur refuse. */
export function deniedOutput(title: string): ExecutedToolOutput {
  return {
    ok: false,
    denied: true,
    content:
      `L'utilisateur a refusé l'action « ${title} ». Ne la retente pas telle quelle : ` +
      `explique ce que tu voulais faire, propose une alternative ou demande comment procéder.`,
  };
}

export { isAllowed };

/**
 * Enveloppe un gestionnaire pour mémoriser les `allow_session` par `scopeKey`
 * (utile en CLI et en test ; l'app fournit son propre gestionnaire).
 */
export function withSessionMemory(handler: PermissionHandler): PermissionHandler {
  const granted = new Set<string>();
  return async (request, signal) => {
    const key = request.scopeKey ?? request.toolName;
    if (granted.has(key)) return 'allow_session';
    const decision = await handler(request, signal);
    if (decision === 'allow_session') granted.add(key);
    return decision;
  };
}
