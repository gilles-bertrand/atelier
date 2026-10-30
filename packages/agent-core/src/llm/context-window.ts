/**
 * Lecture de la fenêtre de contexte réelle du modèle et de ses capacités.
 *
 * L'endpoint `/v1` d'Ollama ignore `num_ctx` : le contexte est fixé côté serveur
 * (Modelfile `atelier` ou `OLLAMA_CONTEXT_LENGTH`). On lit donc `/api/show` ;
 * pour vLLM (pas d'`/api/show`), repli sur `/v1/models` (`max_model_len`).
 */
import {
  AtelierError,
  MIN_CONTEXT_WINDOW,
  MODEL_CAPABILITIES,
  openAiCompatibleBaseUrl,
  type ModelCapability,
} from '@atelier/shared';
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

export interface ModelDetails extends ContextWindowInfo {
  /** Capacités annoncées par `/api/show`. Absent : inconnues (vLLM, Ollama ancien). */
  capabilities?: ModelCapability[];
  /**
   * Famille d'architecture (`details.family`), ex. `qwen3_5_moe`. Absent :
   * inconnue. Les modèles MLX d'Ollama 0.40 ne la donnent qu'ici (vide dans `/api/tags`).
   */
  family?: string;
}

export interface ModelDetailsOptions {
  baseUrl: string;
  model: string;
  token?: string;
  fetch?: FetchFunction;
  signal?: AbortSignal;
}

export interface ContextWindowOptions extends ModelDetailsOptions {
  /** Valeur forcée (réglage `numCtx`). */
  override?: number;
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

/** Capacités connues de {@link ModelCapability}, sans doublon (ex. `audio` ignorée). */
export function parseCapabilities(value: unknown): ModelCapability[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return MODEL_CAPABILITIES.filter((capability) => value.includes(capability));
}

/**
 * Famille d'architecture d'un bloc `details` (`/api/tags` ou `/api/show`) ;
 * une chaîne vide (modèles MLX d'Ollama 0.40 dans `/api/tags`) vaut inconnue.
 */
export function parseFamily(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const family = (details as Record<string, unknown>)['family'];
  return typeof family === 'string' && family !== '' ? family : undefined;
}

/** Convertit la réponse de `/api/show` (Ollama). */
export function parseModelShow(body: unknown): ModelDetails {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const numCtx = parseNumCtx(record['parameters']);
  const modelMax = parseModelMaxContext(record['model_info']);
  const capabilities = parseCapabilities(record['capabilities']);
  const family = parseFamily(record['details']);
  const extra = {
    ...(modelMax !== undefined ? { modelMaxContext: modelMax } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(family !== undefined ? { family } : {}),
  };
  if (numCtx !== undefined) return { contextWindow: numCtx, source: 'num_ctx', ...extra };
  return {
    contextWindow:
      modelMax !== undefined ? Math.min(modelMax, MIN_CONTEXT_WINDOW) : MIN_CONTEXT_WINDOW,
    source: 'assumed',
    ...extra,
  };
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
  const details = await fetchModelDetails(options);
  return {
    contextWindow: details.contextWindow,
    source: details.source,
    ...(details.modelMaxContext !== undefined ? { modelMaxContext: details.modelMaxContext } : {}),
  };
}

/**
 * Capacités et fenêtre de contexte d'un modèle, en un seul `POST /api/show`.
 * vLLM (route absente) : pas de capacités, contexte lu via `max_model_len`.
 */
export async function fetchModelDetails(options: ModelDetailsOptions): Promise<ModelDetails> {
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
  if (response.ok) return parseModelShow(await response.json());
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
  options: ModelDetailsOptions,
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
