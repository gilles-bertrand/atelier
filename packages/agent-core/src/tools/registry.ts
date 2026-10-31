/**
 * Conversion d'un {@link ToolRegistry} (shared) en objet `tools` de l'AI SDK.
 *
 * L'adaptateur injecte le {@link ToolExecutionContext}, applique la politique de
 * permission `always` (vérification préalable de l'outil, puis question ; un
 * échec ou un refus devient un résultat `ok: false`, jamais une exception) et ne
 * renvoie au modèle que le texte (`content`) : l'affichage riche (`display`)
 * reste côté UI.
 */
import { tool, type ToolSet } from 'ai';
import {
  isAllowed,
  type AnyToolDefinition,
  type PermissionHandler,
  type Sandbox,
  type ToolDisplay,
  type ToolExecutionContext,
  type ToolOutput,
  type ToolRegistry,
  type WorkspaceFolder,
} from '@atelier/shared';
import {
  askPermission,
  deniedOutput,
  describePermissionFor,
  precheckTool,
  type PermissionDescriber,
} from './permission.js';

/** Dépendances nécessaires pour exécuter les outils d'un tour. */
export interface ToolRuntime {
  sessionId: string;
  workspace: string;
  /** Dossiers rattachés du projet de la conversation (ADR-003), relus à chaque tour. */
  folders?: readonly WorkspaceFolder[];
  abortSignal: AbortSignal;
  requestPermission: PermissionHandler;
  sandbox?: Sandbox;
  /** Relaie `ToolExecutionContext.emitDisplay` (event `tool_display`). */
  emitDisplay?: (toolCallId: string, display: ToolDisplay) => void;
  /** Libellés fournis par l'application, après ceux de l'outil (voir {@link describePermissionFor}). */
  describePermission?: PermissionDescriber;
  /**
   * Borne la sortie avant qu'elle n'entre dans l'historique (budget de contexte
   * par étape) : appliquée au contenu vu par le modèle et par l'UI.
   */
  limitOutput?: (toolName: string, output: ToolOutput) => ToolOutput;
}

/** Garde de type pour la sortie d'un outil Atelier. */
export function isToolOutput(value: unknown): value is ToolOutput {
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
): Promise<ToolOutput> {
  const context: ToolExecutionContext = {
    sessionId: runtime.sessionId,
    toolCallId,
    workspace: runtime.workspace,
    ...(runtime.folders && runtime.folders.length > 0 ? { folders: runtime.folders } : {}),
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
  const limit = (output: ToolOutput): ToolOutput =>
    runtime.limitOutput ? runtime.limitOutput(definition.name, output) : output;
  if (definition.permission === 'always') {
    // Échec certain (dossier en lecture seule, passage introuvable…) : rendu au
    // modèle sans poser de question à l'utilisateur (ADR-003, D9).
    const failure = await precheckTool(definition, input, context);
    if (failure) return limit(failure);
    const description = describePermissionFor(definition, input, runtime.describePermission);
    const decision = await askPermission(context, definition.name, input, description);
    if (!isAllowed(decision)) return deniedOutput(description.title);
  }
  return limit(await definition.execute(input, context));
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
        value: isToolOutput(output) ? modelText(output) : JSON.stringify(output),
      }),
    });
  }
  return tools;
}

/** Texte vu par le modèle : le contenu, préfixé d'un marqueur d'échec si besoin. */
function modelText(output: ToolOutput): string {
  if (output.ok) return output.content;
  return output.content.startsWith('Erreur') ? output.content : `Erreur : ${output.content}`;
}
