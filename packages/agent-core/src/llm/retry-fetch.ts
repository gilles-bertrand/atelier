/**
 * `fetch` avec nouvelles tentatives et backoff exponentiel (+ gigue) pour les
 * erreurs transitoires : coupure réseau, 429, 502, 503, 504. Les autres réponses
 * (y compris 4xx) sont rendues telles quelles à l'appelant.
 *
 * On ne relance que l'établissement de la requête : une fois les en-têtes reçus,
 * le flux SSE appartient à l'AI SDK.
 */
import { isNetworkError } from './errors.js';

export type FetchFunction = typeof globalThis.fetch;

export interface RetryOptions {
  /** Nombre de nouvelles tentatives (défaut 3, donc 4 essais au total). */
  retries?: number;
  /** Délai initial en ms (défaut 500), doublé à chaque tentative. */
  baseDelayMs?: number;
  /** Plafond du délai en ms (défaut 8 000). */
  maxDelayMs?: number;
  /** `fetch` sous-jacent (injectable pour les tests). */
  fetch?: FetchFunction;
  /** Attente injectable (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Notifié avant chaque nouvelle tentative (journalisation). */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Délai avant la tentative `attempt` (1-based), avec gigue de ±20 %. */
export function backoffDelay(
  attempt: number,
  base: number,
  max: number,
  random = Math.random,
): number {
  const raw = Math.min(max, base * 2 ** (attempt - 1));
  return Math.round(raw * (0.8 + 0.4 * random()));
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** Crée un `fetch` qui réessaie les échecs transitoires. */
export function createRetryingFetch(options: RetryOptions = {}): FetchFunction {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8_000;
  const inner = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;

  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await inner(input, init);
        if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) return response;
        const delayMs = Math.min(
          max,
          retryAfterMs(response) ?? backoffDelay(attempt + 1, base, max),
        );
        options.onRetry?.({ attempt: attempt + 1, delayMs, reason: `HTTP ${response.status}` });
        await response.body?.cancel().catch(() => undefined);
        await sleep(delayMs, signal);
      } catch (error) {
        if (signal?.aborted || !isNetworkError(error) || attempt >= retries) throw error;
        const delayMs = backoffDelay(attempt + 1, base, max);
        options.onRetry?.({
          attempt: attempt + 1,
          delayMs,
          reason: error instanceof Error ? error.message : String(error),
        });
        await sleep(delayMs, signal);
      }
    }
  };
}
