/**
 * @atelier/agent-core — boucle agentique (AI SDK), outils natifs, permissions,
 * compaction. Voir docs/BRIEF.md §1 et §2.
 */

export const PACKAGE_NAME = '@atelier/agent-core';

// Boucle
export { Agent, AgentSession, MAX_STEPS } from './loop/agent.js';
export type { AgentOptions, RunTurnOptions, SendOptions, TurnResult } from './loop/agent.js';
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

// Registre et fabrique pour le process main
export { createDefaultRegistry } from './default-registry.js';
export { createAgentRuntime } from './runtime.js';
export type {
  AgentRuntime,
  AgentRuntimeLlmOptions,
  AgentRuntimeOptions,
  CreateSessionOptions,
  RuntimeContextSource,
} from './runtime.js';
