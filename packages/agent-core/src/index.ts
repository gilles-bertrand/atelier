/**
 * @atelier/agent-core — boucle agentique (AI SDK), outils natifs, permissions,
 * compaction. Voir docs/BRIEF.md §1 et §2.
 */
import { InMemoryToolRegistry, type AnyToolDefinition, type ToolRegistry } from '@atelier/shared';
import { bashTool } from './tools/bash.js';
import { createNativeTools } from './tools/native.js';

export const PACKAGE_NAME = '@atelier/agent-core';

// Boucle
export { Agent, AgentSession, MAX_STEPS } from './loop/agent.js';
export type { AgentOptions, RunTurnOptions, TurnResult } from './loop/agent.js';
export {
  compactMessages,
  findCompactionSplit,
  shouldCompact,
  SUMMARY_PREFIX,
  transcript,
} from './loop/compaction.js';
export type { CompactOptions, CompactResult } from './loop/compaction.js';
export { chatMessagesToModelMessages, stripReasoning } from './loop/history.js';
export { createToolCallRepair, repairToolInput } from './loop/repair.js';
export {
  matchToolName,
  parseLooseJson,
  parseTextToolCalls,
  textToolCallMiddleware,
} from './loop/text-tool-calls.js';
export type { ParsedTextToolCalls, TextToolCall } from './loop/text-tool-calls.js';

// Serveur LLM
export { createLlmModels, disableThinking } from './llm/provider.js';
export type { LlmConnectionOptions, LlmModels } from './llm/provider.js';
export { fetchContextWindow, parseModelMaxContext, parseNumCtx } from './llm/context-window.js';
export type {
  ContextWindowInfo,
  ContextWindowOptions,
  ContextWindowSource,
} from './llm/context-window.js';
export {
  assertServerUrl,
  checkServerHealth,
  fetchServerVersion,
  listModels,
  parseOllamaTags,
  parseOpenAiModels,
  SERVER_CHECK_TIMEOUT_MS,
  SLOW_SERVER_MS,
  testConnection,
} from './llm/server.js';
export type {
  ConnectionTestOptions,
  HealthCheckOptions,
  ModelList,
  ServerFlavor,
  ServerQueryOptions,
} from './llm/server.js';
export { backoffDelay, createRetryingFetch, withRetryListener } from './llm/retry-fetch.js';
export type { FetchFunction, RetryInfo, RetryOptions } from './llm/retry-fetch.js';
export { isNetworkError, toLlmError } from './llm/errors.js';

// Prompt
export { buildSystemPrompt } from './prompt/system-prompt.js';
export type { SystemPromptOptions } from './prompt/system-prompt.js';

// Chemins (réutilisé par packages/documents)
export { isInside, resolveWorkspacePath, tryResolveWorkspacePath } from './paths.js';
export type { ResolvedWorkspacePath } from './paths.js';

// Outils
export {
  createNativeTools,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  presentFileTool,
  readFileTool,
  todoWriteTool,
  writeFileTool,
} from './tools/native.js';
export { BASH_TIMEOUT_MS, BASH_WHITELIST, bashTool, isWhitelistedCommand } from './tools/bash.js';
export { executeTool, isToolOutput, toAiSdkTools } from './tools/registry.js';
export type { ToolRuntime } from './tools/registry.js';
export {
  askPermission,
  deniedOutput,
  describePermissionFor,
  genericDescribePermission,
  withSessionMemory,
} from './tools/permission.js';
export type { PermissionDescriber } from './tools/permission.js';
export { globToRegExp } from './tools/fs-utils.js';
export { DEFAULT_MAX_OUTPUT_BYTES, truncateOutput } from './tools/text.js';
export { LocalSandbox } from './local-sandbox.js';

/**
 * Registre par défaut : outils natifs + bash, plus les outils fournis
 * (documents, web, MCP…). Un outil fourni remplace l'outil natif de même nom
 * (ex. `read_file` de `packages/documents`).
 */
export function createDefaultRegistry(extra: readonly AnyToolDefinition[] = []): ToolRegistry {
  const overridden = new Set(extra.map((t) => t.name));
  const natives = [...createNativeTools(), bashTool as AnyToolDefinition].filter(
    (t) => !overridden.has(t.name),
  );
  return new InMemoryToolRegistry([...natives, ...extra]);
}
