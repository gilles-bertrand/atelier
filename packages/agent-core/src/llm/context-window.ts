/**
 * Lecture de la fenêtre de contexte réelle du modèle.
 *
 * L'endpoint `/v1` d'Ollama ignore `num_ctx` : le contexte est fixé côté serveur
 * (Modelfile `atelier` ou `OLLAMA_CONTEXT_LENGTH`). On lit donc `/api/show` ;
 * pour vLLM (pas d'`/api/show`), repli sur `/v1/models` (`max_model_len`).
 */
import { AtelierError, MIN_CONTEXT_WINDOW, openAiCompatibleBaseUrl } from '@atelier/shared';
import { toLlmError } from './errors.js';
import type { FetchFunction } from './retry-fetch.js';

/** Provenance de la valeur retenue. */
export type ContextWindowSource =
  | 'override' // forcée dans les réglages
  | 'num_ctx' // paramètre `num_ctx` du Modelfile
  | 'vllm' // `max_model_len` de vLLM
  | 'assumed'; // hypothèse : serveur configuré selon docs/SERVER.md

export interface ContextWindowInfo {
  /** Fenêtre de contexte effective en tokens. */
  contextWindow: number;
  /** Contexte maximal supporté par l'architecture (`model_info.*.context_length`). */
  modelMaxContext?: number;
  source: ContextWindowSource;
}

export interface ContextWindowOptions {
  baseUrl: string;
  model: string;
  token?: string;
  /** Valeur forcée (réglage `numCtx`). */
  override?: number;
  fetch?: FetchFunction;
  signal?: AbortSignal;
}

/** Extrait `num_ctx` de la chaîne `parameters` renvoyée par `/api/show`. */
export function parseNumCtx(parameters: unknown): number | undefined {
  if (typeof parameters !== 'string') return undefined;
  const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

/** Extrait `<archi>.context_length` de `model_info`. */
export function parseModelMaxContext(modelInfo: unknown): number | undefined {
  if (typeof modelInfo !== 'object' || modelInfo === null) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value;
  }
  return undefined;
}

function headers(token: string | undefined): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Lit la fenêtre de contexte effective du modèle sur le serveur. */
export async function fetchContextWindow(
  options: ContextWindowOptions,
): Promise<ContextWindowInfo> {
  if (options.override !== undefined && options.override > 0) {
    return { contextWindow: options.override, source: 'override' };
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const root = options.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  let response: Response;
  try {
    response = await doFetch(`${root}/api/show`, {
      method: 'POST',
      headers: headers(options.token),
      body: JSON.stringify({ model: options.model }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw toLlmError(error, root);
  }
  if (response.status === 401 || response.status === 403) {
    throw new AtelierError('llm/unauthorized', `Jeton refusé par le serveur LLM (${root}).`);
  }
  if (response.ok) {
    const body: unknown = await response.json();
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const numCtx = parseNumCtx(record['parameters']);
    const modelMax = parseModelMaxContext(record['model_info']);
    const extra = modelMax !== undefined ? { modelMaxContext: modelMax } : {};
    if (numCtx !== undefined) return { contextWindow: numCtx, source: 'num_ctx', ...extra };
    return {
      contextWindow:
        modelMax !== undefined ? Math.min(modelMax, MIN_CONTEXT_WINDOW) : MIN_CONTEXT_WINDOW,
      source: 'assumed',
      ...extra,
    };
  }
  if (response.status === 404) {
    // Soit le modèle n'existe pas (Ollama), soit l'endpoint n'existe pas (vLLM).
    const text = await response.text().catch(() => '');
    // Ollama : {"error":"model 'x' not found"} ; vLLM : {"detail":"Not Found"}.
    if (/"error"\s*:\s*"[^"]*model[^"]*not found/i.test(text)) {
      throw new AtelierError(
        'llm/model_not_found',
        `Modèle « ${options.model} » absent du serveur.`,
      );
    }
    return fetchVllmContextWindow(options, doFetch);
  }
  throw new AtelierError('llm/bad_response', `/api/show a répondu HTTP ${response.status}.`, {
    retryable: response.status >= 500,
  });
}

async function fetchVllmContextWindow(
  options: ContextWindowOptions,
  doFetch: FetchFunction,
): Promise<ContextWindowInfo> {
  const url = `${openAiCompatibleBaseUrl(options.baseUrl)}/models`;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: headers(options.token),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw toLlmError(error, url);
  }
  if (response.status === 401 || response.status === 403) {
    throw new AtelierError('llm/unauthorized', `Jeton refusé par le serveur LLM (${url}).`);
  }
  if (!response.ok) return { contextWindow: MIN_CONTEXT_WINDOW, source: 'assumed' };
  const body: unknown = await response.json();
  const data =
    typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, max_model_len: maxLen } = entry as { id?: unknown; max_model_len?: unknown };
    if (id === options.model && typeof maxLen === 'number') {
      return { contextWindow: maxLen, source: 'vllm' };
    }
  }
  return { contextWindow: MIN_CONTEXT_WINDOW, source: 'assumed' };
}
