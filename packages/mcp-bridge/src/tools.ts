/**
 * Conversion des outils MCP en outils Atelier ({@link ToolDefinition}) et en
 * outils AI SDK (`dynamicTool` + `jsonSchema`).
 *
 * - Nom : `mcp__<serveur>__<outil>` (`mcpToolName` de shared).
 * - Permission : `never` si le serveur déclare l'outil en lecture seule
 *   (`annotations.readOnlyHint: true`), sinon `always` (brief §6 : toute action
 *   d'écriture MCP demande une permission ; sans annotation, on suppose l'écriture).
 * - Résultat : texte pour le modèle (contenus texte, ressources), tronqué.
 */
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from 'ai';
import {
  defineTool,
  mcpToolName,
  type PermissionDescription,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolOutput,
} from '@atelier/shared';
import { jsonSchemaToZod, normalizeInputSchema, type JsonSchemaObject } from './schema.js';

/** Outil tel que publié par un serveur MCP (`tools/list`). */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** Résultat brut de `tools/call`. */
export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  /** Ancien format (protocole 2024-10-07). */
  toolResult?: unknown;
}

/** Appelle un outil sur un serveur (implémenté par {@link McpManager}). */
export type McpToolCaller = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<McpCallResult>;

/** Outil MCP catalogué : sa définition Atelier et de quoi le retrouver. */
export interface McpCatalogEntry {
  /** Serveur d'origine. */
  server: string;
  /** Nom de l'outil côté serveur. */
  toolName: string;
  /** Titre lisible, si fourni. */
  title?: string;
  /** Description fournie par le serveur. */
  description: string;
  /** Lecture seule déclarée par le serveur. */
  readOnly: boolean;
  /** JSON Schema d'entrée normalisé. */
  inputJsonSchema: JsonSchemaObject;
  /** Définition prête pour le registre. */
  definition: ToolDefinition<Record<string, unknown>>;
}

/** Taille maximale du texte renvoyé au modèle par un outil MCP. */
export const MCP_MAX_OUTPUT_CHARS = 25_000;
/** Longueur maximale de la description envoyée au modèle. */
export const MCP_MAX_DESCRIPTION_CHARS = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n\n[… résultat tronqué à ${max} caractères]`;
}

function safeJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Cycle ou BigInt : rare dans une réponse JSON-RPC, on reste lisible.
    return '[valeur non sérialisable]';
  }
}

/** Convertit un bloc de contenu MCP en texte pour le modèle. */
function contentToText(block: unknown): string {
  if (!isRecord(block)) return safeJson(block);
  switch (block.type) {
    case 'text':
      return str(block.text) ?? '';
    case 'image':
    case 'audio': {
      const kind = block.type === 'image' ? 'image' : 'audio';
      return `[${kind} ${str(block.mimeType) ?? ''} renvoyée par le connecteur, non transmise]`;
    }
    case 'resource': {
      const resource = isRecord(block.resource) ? block.resource : {};
      const uri = str(resource.uri) ?? '';
      const text = str(resource.text);
      return text !== undefined
        ? `--- ressource ${uri} ---\n${text}`
        : `[ressource binaire ${uri} (${str(resource.mimeType) ?? 'type inconnu'}), non transmise]`;
    }
    case 'resource_link':
      return `[lien vers la ressource ${str(block.name) ?? ''} : ${str(block.uri) ?? ''}]`;
    default:
      return safeJson(block);
  }
}

/** Texte renvoyé au modèle pour un résultat `tools/call`. */
export function formatCallResult(
  result: McpCallResult,
  maxChars = MCP_MAX_OUTPUT_CHARS,
): ToolOutput {
  const parts = Array.isArray(result.content) ? result.content.map(contentToText) : [];
  let text = parts.filter((p) => p !== '').join('\n\n');
  if (text === '' && result.structuredContent !== undefined)
    text = safeJson(result.structuredContent);
  if (text === '' && result.toolResult !== undefined) text = safeJson(result.toolResult);
  if (result.isError === true) {
    return {
      ok: false,
      content: truncate(text || 'Le connecteur a signalé une erreur sans détail.', maxChars),
    };
  }
  return { ok: true, content: truncate(text || '(résultat vide)', maxChars) };
}

/** Libellé de la demande de permission pour un outil MCP. */
export function describeMcpPermission(
  server: string,
  tool: McpToolInfo,
  input: unknown,
): PermissionDescription {
  const label = tool.annotations?.title ?? tool.title ?? tool.name;
  const detail = safeJson(input);
  return {
    kind: 'mcp_write',
    title: `Utiliser « ${label} » du connecteur ${server}`,
    detail: detail.length > 2_000 ? `${detail.slice(0, 2_000)}\n…` : detail,
    scopeKey: mcpToolName(server, tool.name),
  };
}

function modelDescription(server: string, tool: McpToolInfo): string {
  const title = tool.annotations?.title ?? tool.title;
  const head = `[Connecteur MCP « ${server} »${title ? ` : ${title}` : ''}]`;
  const body = (tool.description ?? '').trim();
  const text = body ? `${head} ${body}` : head;
  return text.length > MCP_MAX_DESCRIPTION_CHARS
    ? `${text.slice(0, MCP_MAX_DESCRIPTION_CHARS - 1)}…`
    : text;
}

/** Construit l'entrée de catalogue (et la {@link ToolDefinition}) d'un outil MCP. */
export function toCatalogEntry(
  server: string,
  tool: McpToolInfo,
  call: McpToolCaller,
): McpCatalogEntry {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const inputJsonSchema = normalizeInputSchema(tool.inputSchema);
  const description = modelDescription(server, tool);
  const definition = defineTool<Record<string, unknown>>({
    name: mcpToolName(server, tool.name),
    description,
    inputSchema: jsonSchemaToZod(inputJsonSchema),
    permission: readOnly ? 'never' : 'always',
    source: 'mcp',
    describePermission: (input) => describeMcpPermission(server, tool, input),
    async execute(input, context: ToolExecutionContext): Promise<ToolOutput> {
      try {
        return formatCallResult(await call(server, tool.name, input, context.abortSignal));
      } catch (error) {
        if (context.abortSignal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, content: `Échec du connecteur ${server} : ${message}` };
      }
    },
  });
  return {
    server,
    toolName: tool.name,
    ...((tool.annotations?.title ?? tool.title)
      ? { title: tool.annotations?.title ?? tool.title }
      : {}),
    description: (tool.description ?? '').trim(),
    readOnly,
    inputJsonSchema,
    definition,
  };
}

/**
 * Variante AI SDK brute (`dynamicTool` + `jsonSchema`), pour un usage hors
 * agent-core (scripts, tests). Elle n'applique PAS la politique de permission :
 * dans l'app, passer par les {@link ToolDefinition} et le registre.
 */
export function toDynamicTool(entry: McpCatalogEntry, call: McpToolCaller): Tool {
  return dynamicTool({
    description: entry.definition.description,
    inputSchema: jsonSchema(entry.inputJsonSchema as JSONSchema7),
    execute: async (input, options) => {
      const args = isRecord(input) ? input : {};
      return formatCallResult(await call(entry.server, entry.toolName, args, options.abortSignal))
        .content;
    },
  });
}
