/**
 * Interrogation du serveur LLM pour les Réglages et l'onboarding : liste des
 * modèles, version, test de connexion, santé.
 *
 * Ollama expose `/api/tags`, `/api/version`, `/api/show` ; vLLM (docs/SERVER.md
 * §5) n'expose que l'API OpenAI-compatible. Chaque fonction essaie d'abord la
 * route Ollama puis se rabat sur `GET /v1/models` quand elle répond 404.
 */
import {
  AtelierError,
  checkServerUrl,
  isAtelierError,
  openAiCompatibleBaseUrl,
  type ConnectionTestResult,
  type LlmModelInfo,
  type ServerHealth,
  type ServerStatus,
} from '@atelier/shared';
import { fetchContextWindow } from './context-window.js';
import { toLlmError } from './errors.js';
import type { FetchFunction } from './retry-fetch.js';

/** Type de serveur détecté. */
export type ServerFlavor = 'ollama' | 'openai-compatible';

export interface ServerQueryOptions {
  /** URL de base, sans `/v1`. */
  baseUrl: string;
  token?: string;
  fetch?: FetchFunction;
  signal?: AbortSignal;
}

export interface ModelList {
  models: LlmModelInfo[];
  flavor: ServerFlavor;
}

/** Latence au-delà de laquelle le serveur est jugé « lent » (ms). */
export const SLOW_SERVER_MS = 2_000;
/** Délai par défaut d'un test de connexion ou d'un contrôle de santé (ms). */
export const SERVER_CHECK_TIMEOUT_MS = 10_000;

function rootUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Lève une {@link AtelierError} si l'URL ne respecte pas la règle https / localhost / Tailscale. */
export function assertServerUrl(baseUrl: string): void {
  const check = checkServerUrl(baseUrl);
  if (check.ok) return;
  throw new AtelierError(
    check.reason === 'insecure_http' ? 'llm/insecure_url' : 'llm/unreachable',
    check.reason === 'insecure_http'
      ? 'URL refusée : utilise https://, ou http:// uniquement pour localhost ou une adresse Tailscale.'
      : `URL du serveur invalide : ${baseUrl}`,
  );
}

async function get(url: string, options: ServerQueryOptions): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: authHeaders(options.token),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw toLlmError(error, rootUrl(options.baseUrl));
  }
  if (response.status === 401 || response.status === 403) {
    throw new AtelierError(
      'llm/unauthorized',
      `Jeton refusé par le serveur LLM (${rootUrl(options.baseUrl)}).`,
    );
  }
  return response;
}

async function readJson(response: Response, what: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new AtelierError('llm/bad_response', `${what} : réponse JSON invalide.`, {
      cause: error,
    });
  }
}

/** Convertit la réponse de `/api/tags` (Ollama). */
export function parseOllamaTags(body: unknown): LlmModelInfo[] {
  const models = asRecord(body)['models'];
  if (!Array.isArray(models)) return [];
  const out: LlmModelInfo[] = [];
  for (const entry of models) {
    const record = asRecord(entry);
    const name = record['name'] ?? record['model'];
    if (typeof name !== 'string' || name === '') continue;
    const details = asRecord(record['details']);
    const info: LlmModelInfo = { name };
    if (typeof record['size'] === 'number') info.sizeBytes = record['size'];
    if (typeof details['family'] === 'string') info.family = details['family'];
    if (typeof details['quantization_level'] === 'string') {
      info.quantization = details['quantization_level'];
    }
    out.push(info);
  }
  return out;
}

/** Convertit la réponse de `/v1/models` (vLLM, ou tout serveur OpenAI-compatible). */
export function parseOpenAiModels(body: unknown): LlmModelInfo[] {
  const data = asRecord(body)['data'];
  if (!Array.isArray(data)) return [];
  const out: LlmModelInfo[] = [];
  for (const entry of data) {
    const id = asRecord(entry)['id'];
    if (typeof id === 'string' && id !== '') out.push({ name: id });
  }
  return out;
}

async function listOpenAiModels(options: ServerQueryOptions): Promise<LlmModelInfo[]> {
  const response = await get(`${openAiCompatibleBaseUrl(options.baseUrl)}/models`, options);
  if (!response.ok) {
    throw new AtelierError('llm/bad_response', `/v1/models a répondu HTTP ${response.status}.`, {
      retryable: response.status >= 500,
      details: { status: response.status },
    });
  }
  return parseOpenAiModels(await readJson(response, '/v1/models'));
}

/**
 * Liste les modèles du serveur : `/api/tags` (Ollama), sinon repli sur
 * `/v1/models` (vLLM) si la route Ollama n'existe pas.
 */
export async function listModels(options: ServerQueryOptions): Promise<ModelList> {
  assertServerUrl(options.baseUrl);
  const response = await get(`${rootUrl(options.baseUrl)}/api/tags`, options);
  if (response.ok) {
    return { models: parseOllamaTags(await readJson(response, '/api/tags')), flavor: 'ollama' };
  }
  if (response.status === 404 || response.status === 405) {
    return { models: await listOpenAiModels(options), flavor: 'openai-compatible' };
  }
  throw new AtelierError('llm/bad_response', `/api/tags a répondu HTTP ${response.status}.`, {
    retryable: response.status >= 500,
    details: { status: response.status },
  });
}

/** Version d'Ollama (`/api/version`) ; `undefined` si la route n'existe pas (vLLM). */
export async function fetchServerVersion(options: ServerQueryOptions): Promise<string | undefined> {
  const response = await get(`${rootUrl(options.baseUrl)}/api/version`, options);
  if (!response.ok) return undefined;
  const version = asRecord(await response.json().catch(() => undefined))['version'];
  return typeof version === 'string' ? version : undefined;
}

/** Combine le signal de l'appelant et un délai. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface ConnectionTestOptions extends ServerQueryOptions {
  /** Modèle choisi : vérifie sa présence et lit sa fenêtre de contexte. */
  model?: string;
  /** Contexte forcé dans les Réglages. */
  numCtx?: number;
  /** Délai global (défaut {@link SERVER_CHECK_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
}

function failure(error: unknown, baseUrl: string): ConnectionTestResult {
  const atelier = isAtelierError(error) ? error : toLlmError(error, rootUrl(baseUrl));
  return { ok: false, models: [], errorCode: atelier.code, errorMessage: atelier.message };
}

/**
 * Bouton « Tester la connexion » (canal `llm:test-connection`). Ne lève jamais :
 * l'échec est décrit dans le résultat (`errorCode`, `errorMessage`).
 */
export async function testConnection(
  options: ConnectionTestOptions,
): Promise<ConnectionTestResult> {
  const now = options.now ?? Date.now;
  const query: ServerQueryOptions = {
    ...options,
    signal: withTimeout(options.signal, options.timeoutMs ?? SERVER_CHECK_TIMEOUT_MS),
  };
  try {
    assertServerUrl(options.baseUrl);
    const start = now();
    const { models, flavor } = await listModels(query);
    const latencyMs = Math.max(0, Math.round(now() - start));
    const result: ConnectionTestResult = { ok: true, latencyMs, models };
    if (flavor === 'ollama') {
      const version = await fetchServerVersion(query).catch(() => undefined);
      if (version !== undefined) result.serverVersion = version;
    }
    if (options.model !== undefined && options.model !== '') {
      const model = options.model;
      if (!models.some((m) => m.name === model)) {
        return {
          ...result,
          ok: false,
          errorCode: 'llm/model_not_found',
          errorMessage: `Modèle « ${model} » absent du serveur.`,
        };
      }
      const context = await fetchContextWindow({
        baseUrl: options.baseUrl,
        model,
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.numCtx !== undefined ? { override: options.numCtx } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(query.signal ? { signal: query.signal } : {}),
      });
      result.contextWindow = context.contextWindow;
    }
    return result;
  } catch (error) {
    return failure(error, options.baseUrl);
  }
}

export interface HealthCheckOptions extends ServerQueryOptions {
  timeoutMs?: number;
  /** Seuil « lent » en ms (défaut {@link SLOW_SERVER_MS}). */
  slowMs?: number;
  now?: () => number;
}

/**
 * Contrôle léger pour l'indicateur permanent (canal `llm:status`) :
 * `GET /v1/models`, commun à Ollama et vLLM. Ne lève jamais.
 */
export async function checkServerHealth(options: HealthCheckOptions): Promise<ServerStatus> {
  const now = options.now ?? Date.now;
  const query: ServerQueryOptions = {
    ...options,
    signal: withTimeout(options.signal, options.timeoutMs ?? SERVER_CHECK_TIMEOUT_MS),
  };
  const start = now();
  let health: ServerHealth;
  let latencyMs: number | undefined;
  try {
    assertServerUrl(options.baseUrl);
    await listOpenAiModels(query);
    latencyMs = Math.max(0, Math.round(now() - start));
    health = latencyMs > (options.slowMs ?? SLOW_SERVER_MS) ? 'slow' : 'connected';
  } catch {
    health = 'offline';
  }
  return {
    health,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    checkedAt: new Date().toISOString(),
  };
}
