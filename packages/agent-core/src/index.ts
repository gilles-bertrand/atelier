/**
 * @atelier/agent-core — boucle agentique (AI SDK), outils natifs, permissions,
 * compaction. Voir docs/BRIEF.md §1 et §2.
 */

export const PACKAGE_NAME = '@atelier/agent-core';

// Boucle
export {
  Agent,
  AgentSession,
  announceOnlyPrompt,
  announcesAction,
  continuationPrompt,
  emptyFinalError,
  emptyFinalPrompt,
  isStreamCut,
  LOGGED_RESPONSE_BODY_CHARS,
  MAX_CONTINUATIONS,
  MAX_EMPTY_FINAL_RETRIES,
  MAX_STEPS,
  MAX_STREAM_CUT_RETRIES,
  streamCutError,
  streamCutPrompt,
  streamCutReason,
  streamErrorLog,
} from './loop/agent.js';
export type {
  AgentOptions,
  RunTurnOptions,
  SendOptions,
  StreamCutReason,
  TurnResult,
} from './loop/agent.js';
export {
  estimateTokens,
  MIN_TOOL_OUTPUT_TOKENS,
  STEP_OUTPUT_SHARE,
  ToolOutputBudget,
  TOOL_OUTPUT_SHARE,
  truncateToTokens,
  truncationNotice,
} from './loop/budget.js';
export type { TruncatedText } from './loop/budget.js';
export {
  APP_MESSAGE_PREFIX,
  COMPACTION_TARGET_SHARE,
  compactMessages,
  currentTurnStart,
  estimateMessagesTokens,
  findCompactionSplit,
  injectedKind,
  injectedMessage,
  PRUNED_PREFIX,
  prunedResult,
  pruneToolResults,
  shouldCompact,
  SUMMARY_PREFIX,
  transcript,
} from './loop/compaction.js';
export type { CompactOptions, CompactResult, InjectedKind } from './loop/compaction.js';
export { tokensPerSecond, TurnUsageMeter, usageLine } from './loop/usage.js';
export { chatMessagesToModelMessages, stripReasoning } from './loop/history.js';
export { createToolCallRepair, repairToolInput } from './loop/repair.js';
export {
  capBytes,
  matchesTrigger,
  normalizeForMatch,
  requestText,
  SKILL_AUTOLOAD_MAX_BYTES,
  skillAutoloadMessages,
  skillAutoloadPrompt,
  triggeredSkills,
} from './loop/skill-autoload.js';
export {
  CORRECTION_PREFIX,
  extractNumbers,
  MIN_CHECKED_AMOUNT,
  numberValues,
  sourceText,
  unverifiedAmounts,
  verificationPrompt,
} from './loop/numbers.js';
export {
  isCallPreambleAllowed,
  MAX_TEXT_CALL_PREAMBLE,
  matchToolName,
  parseLooseJson,
  parseTextToolCalls,
  quotedCallSignatures,
  textToolCallMiddleware,
} from './loop/text-tool-calls.js';
export type { ParsedTextToolCalls, TextToolCall } from './loop/text-tool-calls.js';

// Serveur LLM
export { createLlmModels, disableThinking } from './llm/provider.js';
export type { LlmConnectionOptions, LlmModels } from './llm/provider.js';
export {
  fetchContextWindow,
  fetchModelDetails,
  parseCapabilities,
  parseModelMaxContext,
  parseModelShow,
  parseNumCtx,
} from './llm/context-window.js';
export type {
  ContextWindowInfo,
  ContextWindowOptions,
  ContextWindowSource,
  ModelDetails,
  ModelDetailsOptions,
} from './llm/context-window.js';
export {
  assertServerUrl,
  checkServerHealth,
  DESCRIBE_CONCURRENCY,
  describeModels,
  fetchLoadedModels,
  fetchServerVersion,
  listModels,
  parseOllamaPs,
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
export { isNetworkError, toLlmError, unsupportedCapability } from './llm/errors.js';

// Prompt
export { buildSystemPrompt } from './prompt/system-prompt.js';
export type { SystemPromptOptions } from './prompt/system-prompt.js';

// Chemins (réutilisé par packages/documents)
export {
  isInside,
  resolveReadablePath,
  resolveWorkspacePath,
  skillReadRoots,
  tryResolveWorkspacePath,
} from './paths.js';
export type { ReadRoot, ResolvedReadablePath, ResolvedWorkspacePath } from './paths.js';

// Outils
export {
  createListDirTool,
  createNativeTools,
  createReadFileTool,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  presentFileTool,
  readFileTool,
  todoWriteTool,
  writeFileTool,
} from './tools/native.js';
export type { NativeToolsOptions } from './tools/native.js';
export { BASH_TIMEOUT_MS, BASH_WHITELIST, bashTool, isWhitelistedCommand } from './tools/bash.js';
export { executeTool, isToolOutput, toAiSdkTools } from './tools/registry.js';
export type { ToolRuntime } from './tools/registry.js';
export {
  askPermission,
  deniedOutput,
  describePermissionFor,
  genericDescribePermission,
  UNATTENDED_INSTRUCTIONS,
  unattendedPermissionHandler,
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
