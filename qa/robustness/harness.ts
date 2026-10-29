/**
 * Harnais de la campagne de robustesse : un agent assemblé comme dans l'app
 * (`createAgentRuntime` + outils documents + web, VM Lima optionnelle), un vrai
 * modèle (Ollama), et une trace complète du tour pour juger le comportement.
 */
import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequest,
  Sandbox,
  SearchProvider,
  SkillInfo,
  WebSearchResult,
} from '@atelier/shared';
import { createAgentRuntime, createLlmModels } from '@atelier/agent-core';
import { createDocumentTools, createVisionAnalyzer } from '@atelier/documents';
import { createWebTools, type FetchLike, type ResolveHost } from '@atelier/web';

export const LLM_URL = process.env['ATELIER_LLM_URL'] ?? 'http://localhost:11434';
export const LLM_MODEL = process.env['ATELIER_MODEL'] ?? 'atelier';

export interface ToolCallTrace {
  toolCallId: string;
  name: string;
  input: unknown;
  ok?: boolean;
  denied?: boolean;
  output?: string;
}

export interface RunTrace {
  prompt: string;
  toolCalls: ToolCallTrace[];
  permissions: PermissionRequest[];
  text: string;
  reasoning: string;
  reason: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  repairs: number;
  compactions: number;
  continuations: number;
  logs: string[];
}

export type PermissionPolicy =
  'allow' | 'deny' | ((request: PermissionRequest) => PermissionDecision);

export interface RunOptions {
  workspace: string;
  prompt: string;
  permission?: PermissionPolicy;
  sandbox?: Sandbox;
  skills?: readonly SkillInfo[];
  /** Résultats renvoyés par le faux fournisseur de recherche. */
  searchResults?: WebSearchResult[];
  /** `fetch` de web_fetch (pages piégées servies sous un domaine public fictif). */
  webFetch?: FetchLike;
  resolveHost?: ResolveHost;
  thinking?: boolean;
  maxSteps?: number;
  timeoutMs?: number;
}

/** Fournisseur de recherche figé (le réseau réel n'est pas l'objet de la campagne). */
function fixedSearch(results: WebSearchResult[]): SearchProvider {
  return {
    id: 'searxng',
    search: () => Promise.resolve(results),
    isAvailable: () => Promise.resolve(true),
  };
}

export async function runAgent(options: RunOptions): Promise<RunTrace> {
  const logs: string[] = [];
  let repairs = 0;
  let compactions = 0;
  let continuations = 0;
  const thinking = options.thinking ?? true;
  const vision = createVisionAnalyzer({
    model: createLlmModels({ baseUrl: LLM_URL, model: LLM_MODEL, thinking: false }).fastModel,
  });
  const runtime = await createAgentRuntime({
    llm: { baseUrl: LLM_URL, model: LLM_MODEL, thinking },
    tools: [
      ...createDocumentTools({ vision, cache: false }),
      ...createWebTools({
        provider: fixedSearch(options.searchResults ?? []),
        fetch: {
          ...(options.webFetch ? { fetch: options.webFetch } : {}),
          ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
        },
      }),
    ],
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    log: (message, data) => {
      logs.push(`${message} ${data ? JSON.stringify(data) : ''}`);
      if (message === 'repair') repairs += 1;
      if (message === 'compaction') compactions += 1;
      if (message === 'continuation') continuations += 1;
    },
  });

  const permissions: PermissionRequest[] = [];
  const policy = options.permission ?? 'allow';
  const session = runtime.createSession({
    sessionId: `qa-${Date.now().toString(36)}`,
    workspace: options.workspace,
    requestPermission: (request) => {
      permissions.push(request);
      if (policy === 'allow') return Promise.resolve('allow_once');
      if (policy === 'deny') return Promise.resolve('deny');
      return Promise.resolve(policy(request));
    },
  });

  const calls = new Map<string, ToolCallTrace>();
  let text = '';
  let reasoning = '';
  let errorMessage: string | undefined;
  const emit = (event: AgentEvent): void => {
    switch (event.type) {
      case 'text_delta':
        text += event.delta;
        break;
      case 'reasoning_delta':
        reasoning += event.delta;
        break;
      case 'tool_start':
        calls.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: event.input,
        });
        break;
      case 'tool_result': {
        const call = calls.get(event.toolCallId) ?? {
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: undefined,
        };
        calls.set(event.toolCallId, {
          ...call,
          ok: event.ok,
          output: event.output,
          ...(event.denied ? { denied: true } : {}),
        });
        break;
      }
      case 'error':
        errorMessage = `${event.error.code}: ${event.error.message}`;
        break;
      default:
        break;
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    options.timeoutMs ?? 10 * 60_000,
  );
  const started = Date.now();
  try {
    const result = await session.send(options.prompt, emit, controller.signal);
    return {
      prompt: options.prompt,
      toolCalls: [...calls.values()],
      permissions,
      text,
      reasoning,
      reason: result.reason,
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
      durationMs: Date.now() - started,
      repairs,
      compactions,
      continuations,
      logs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Tout le texte produit pendant le tour (réponse + sorties d'outils + entrées). */
export function everything(trace: RunTrace): string {
  return [
    trace.text,
    ...trace.toolCalls.map((c) => `${JSON.stringify(c.input)}\n${c.output ?? ''}`),
  ].join('\n');
}
