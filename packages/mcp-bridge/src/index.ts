/**
 * @atelier/mcp-bridge — connecteurs MCP (stdio + streamable HTTP, lancés côté
 * hôte) exposés comme outils Atelier `mcp__<serveur>__<outil>`, chargés à la
 * demande via `tool_search`. Voir docs/BRIEF.md §6.
 */
export const PACKAGE_NAME = '@atelier/mcp-bridge';

export {
  defaultMcpConfigPath,
  loadMcpConfig,
  parseMcpConfig,
  parseMcpConfigText,
} from './config.js';
export type {
  McpConfig,
  McpConfigIssue,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from './config.js';
export {
  DEFAULT_EXTRA_PATH,
  McpConnection,
  buildServerEnv,
  defaultTransportFactory,
} from './connection.js';
export type {
  McpConnectionOptions,
  McpServerState,
  McpServerStatus,
  ReconnectPolicy,
  TransportFactory,
} from './connection.js';
export { McpManager } from './manager.js';
export type { McpManagerOptions } from './manager.js';
export { jsonSchemaToZod, normalizeInputSchema } from './schema.js';
export type { JsonSchemaObject } from './schema.js';
export {
  TOOL_SEARCH_MAX_RESULTS,
  describeParameters,
  mcpPromptSection,
  searchCatalog,
  tokenize,
  toolSearchTool,
} from './search.js';
export type {
  McpCatalogSource,
  ToolSearchHit,
  ToolSearchInput,
  ToolSearchOptions,
} from './search.js';
export {
  MCP_MAX_DESCRIPTION_CHARS,
  MCP_MAX_OUTPUT_CHARS,
  describeMcpPermission,
  formatCallResult,
  toCatalogEntry,
  toDynamicTool,
} from './tools.js';
export type { McpCallResult, McpCatalogEntry, McpToolCaller, McpToolInfo } from './tools.js';
