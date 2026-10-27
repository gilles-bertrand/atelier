/**
 * Conversion d'un {@link ToolRegistry} (shared) en objet `tools` de l'AI SDK.
 *
 * L'adaptateur injecte le {@link ToolExecutionContext}, applique la politique de
 * permission `always` (un refus devient un résultat `ok: false`, jamais une
 * exception) et ne renvoie au modèle que le texte (`content`) : l'affichage riche
 * (`display`) reste côté UI.
 */
import { tool, type ToolSet } from 'ai';
import {
  isAllowed,
  type AnyToolDefinition,
  type PermissionHandler,
  type Sandbox,
  type ToolDisplay,
  type ToolExecutionContext,
  type ToolRegistry,
} from '@atelier/shared';
import {
  askPermission,
  defaultDescribePermission,
  deniedOutput,
  type ExecutedToolOutput,
  type PermissionDescriber,
} from './permission.js';

/** Dépendances nécessaires pour exécuter les outils d'un tour. */
export interface ToolRuntime {
  sessionId: string;
  workspace: string;
  abortSignal: AbortSignal;
  requestPermission: PermissionHandler;
  sandbox?: Sandbox;
  emitDisplay?: (toolCallId: string, display: ToolDisplay) => void;
  /** Libellés des demandes de permission (défaut : {@link defaultDescribePermission}). */
  describePermission?: PermissionDescriber;
}

/** Garde de type pour la sortie interne d'un outil. */
export function isExecutedToolOutput(value: unknown): value is ExecutedToolOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean' &&
    typeof (value as { content?: unknown }).content === 'string'
  );
}

/** Exécute un outil Atelier avec son contexte et la politique de permission. */
export async function executeTool(
  definition: AnyToolDefinition,
  input: unknown,
  toolCallId: string,
  runtime: ToolRuntime,
): Promise<ExecutedToolOutput> {
  const context: ToolExecutionContext = {
    sessionId: runtime.sessionId,
    toolCallId,
    workspace: runtime.workspace,
    abortSignal: runtime.abortSignal,
    requestPermission: runtime.requestPermission,
    ...(runtime.sandbox ? { sandbox: runtime.sandbox } : {}),
    ...(runtime.emitDisplay
      ? {
          emitDisplay: (display: ToolDisplay) => {
            runtime.emitDisplay?.(toolCallId, display);
          },
        }
      : {}),
  };
  if (definition.permission === 'always') {
    const describe = runtime.describePermission ?? defaultDescribePermission;
    const description = describe(definition.name, input);
    const decision = await askPermission(context, definition.name, input, description);
    if (!isAllowed(decision)) return deniedOutput(description.title);
  }
  return definition.execute(input, context);
}

/**
 * Produit l'objet `tools` de `streamText` à partir du registre.
 * Appelé à chaque tour (le registre peut évoluer : MCP, skills…).
 */
export function toAiSdkTools(registry: ToolRegistry, runtime: ToolRuntime): ToolSet {
  const tools: ToolSet = {};
  for (const definition of registry.list()) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: (input: unknown, options) =>
        executeTool(definition, input, options.toolCallId, runtime),
      toModelOutput: ({ output }) => ({
        type: 'text',
        value: isExecutedToolOutput(output) ? modelText(output) : JSON.stringify(output),
      }),
    });
  }
  return tools;
}

/** Texte vu par le modèle : le contenu, préfixé d'un marqueur d'échec si besoin. */
function modelText(output: ExecutedToolOutput): string {
  if (output.ok) return output.content;
  return output.content.startsWith('Erreur') ? output.content : `Erreur : ${output.content}`;
}
