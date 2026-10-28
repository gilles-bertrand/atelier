/**
 * Appels de diagnostic au serveur LLM (Ollama, repli vLLM) : « Tester la
 * connexion », liste des modèles et sonde de santé. Le `fetch` est injecté.
 */
import { fetchContextWindow } from '@atelier/agent-core';
import {
  AtelierError,
  checkServerUrl,
  isAtelierError,
  type AtelierErrorCode,
  type ConnectionTestResult,
  type LlmModelInfo,
} from '@atelier/shared';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ServerTarget {
  baseUrl: string;
  token?: string | undefined;
}

/** Délai par défaut d'une requête de diagnostic. */
export const DIAGNOSTIC_TIMEOUT_MS = 8_000;

/** Messages français par code, pour le résultat de « Tester la connexion ». */
const TEST_MESSAGES: Partial<Record<AtelierErrorCode, string>> = {
  'llm/insecure_url':
    'Adresse refusée : utilisez https:// (http:// est accepté seulement pour localhost et Tailscale).',
  'llm/unreachable': 'Serveur injoignable. Vérifiez l’adresse et votre connexion (VPN compris).',
  'llm/unauthorized': 'Le serveur refuse le jeton d’accès. Vérifiez le token.',
  'llm/timeout': 'Le serveur met trop de temps à répondre.',
  'llm/bad_response': 'Le serveur répond, mais ce n’est pas un serveur Ollama compatible.',
};

function base(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function headers(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  token: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: headers(token), signal: combined });
  } catch (error) {
    if (timeout.aborted)
      throw new AtelierError('llm/timeout', `Délai dépassé : ${url}`, { retryable: true });
    throw new AtelierError('llm/unreachable', `Serveur injoignable : ${url}`, {
      retryable: true,
      cause: error,
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new AtelierError('llm/unauthorized', `HTTP ${String(response.status)} sur ${url}`);
  }
  if (!response.ok) {
    throw new AtelierError('llm/bad_response', `HTTP ${String(response.status)} sur ${url}`, {
      details: { status: response.status },
    });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new AtelierError('llm/bad_response', `Réponse non JSON : ${url}`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Normalise la réponse de `/api/tags`. */
export function parseTags(raw: unknown): LlmModelInfo[] {
  if (!isRecord(raw) || !Array.isArray(raw['models'])) return [];
  const out: LlmModelInfo[] = [];
  for (const entry of raw['models'] as unknown[]) {
    if (!isRecord(entry)) continue;
    const name = typeof entry['name'] === 'string' ? entry['name'] : entry['model'];
    if (typeof name !== 'string') continue;
    const details = isRecord(entry['details']) ? entry['details'] : {};
    out.push({
      name,
      ...(typeof entry['size'] === 'number' ? { sizeBytes: entry['size'] } : {}),
      ...(typeof details['family'] === 'string' ? { family: details['family'] } : {}),
      ...(typeof details['quantization_level'] === 'string'
        ? { quantization: details['quantization_level'] }
        : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Normalise la réponse OpenAI `/v1/models` (repli vLLM). */
export function parseOpenAiModels(raw: unknown): LlmModelInfo[] {
  if (!isRecord(raw) || !Array.isArray(raw['data'])) return [];
  return (raw['data'] as unknown[])
    .filter(isRecord)
    .map((m) => m['id'])
    .filter((id): id is string => typeof id === 'string')
    .map((name) => ({ name }));
}

/** Liste les modèles (`/api/tags`, sinon `/v1/models`). */
export async function listModels(
  target: ServerTarget,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<LlmModelInfo[]> {
  const root = base(target.baseUrl);
  try {
    return parseTags(
      await getJson(fetchImpl, `${root}/api/tags`, target.token, DIAGNOSTIC_TIMEOUT_MS, signal),
    );
  } catch (error) {
    if (isAtelierError(error) && error.code === 'llm/bad_response') {
      return parseOpenAiModels(
        await getJson(fetchImpl, `${root}/v1/models`, target.token, DIAGNOSTIC_TIMEOUT_MS, signal),
      );
    }
    throw error;
  }
}

/**
 * Sonde légère : `/api/version` (Ollama), sinon `/v1/models` (vLLM).
 * Renvoie la latence et la version si disponible ; rejette une `AtelierError`.
 */
export async function probeServer(
  target: ServerTarget,
  fetchImpl: FetchLike = fetch,
  options: { timeoutMs?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<{ latencyMs: number; version?: string }> {
  const now = options.now ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? DIAGNOSTIC_TIMEOUT_MS;
  const root = base(target.baseUrl);
  const started = now();
  try {
    const raw = await getJson(
      fetchImpl,
      `${root}/api/version`,
      target.token,
      timeoutMs,
      options.signal,
    );
    const version =
      isRecord(raw) && typeof raw['version'] === 'string' ? raw['version'] : undefined;
    return { latencyMs: Math.round(now() - started), ...(version ? { version } : {}) };
  } catch (error) {
    if (!(isAtelierError(error) && error.code === 'llm/bad_response')) throw error;
    await getJson(fetchImpl, `${root}/v1/models`, target.token, timeoutMs, options.signal);
    return { latencyMs: Math.round(now() - started) };
  }
}

/**
 * « Tester la connexion » (onboarding, Réglages) : URL sûre, latence, version,
 * modèles, contexte réel du modèle choisi. Ne rejette jamais.
 */
export async function testConnection(
  request: ServerTarget & { model?: string | undefined },
  fetchImpl: FetchLike = fetch,
): Promise<ConnectionTestResult> {
  const check = checkServerUrl(request.baseUrl);
  if (!check.ok) {
    const errorCode: AtelierErrorCode =
      check.reason === 'insecure_http' ? 'llm/insecure_url' : 'llm/unreachable';
    return {
      ok: false,
      models: [],
      errorCode,
      errorMessage:
        check.reason === 'insecure_http'
          ? (TEST_MESSAGES['llm/insecure_url'] ?? '')
          : 'Adresse invalide. Exemple : https://llm.mon-entreprise.fr',
    };
  }
  try {
    const probe = await probeServer(request, fetchImpl);
    const models = await listModels(request, fetchImpl);
    const model = request.model ?? models[0]?.name;
    let contextWindow: number | undefined;
    if (model && models.some((m) => m.name === model)) {
      try {
        const info = await fetchContextWindow({
          baseUrl: base(request.baseUrl),
          model,
          ...(request.token ? { token: request.token } : {}),
          fetch: fetchImpl as typeof fetch,
        });
        contextWindow = info.contextWindow;
      } catch {
        contextWindow = undefined;
      }
    }
    return {
      ok: true,
      latencyMs: probe.latencyMs,
      ...(probe.version ? { serverVersion: probe.version } : {}),
      models,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  } catch (error) {
    const code: AtelierErrorCode = isAtelierError(error) ? error.code : 'llm/unreachable';
    return {
      ok: false,
      models: [],
      errorCode: code,
      errorMessage: TEST_MESSAGES[code] ?? 'Connexion impossible.',
    };
  }
}
