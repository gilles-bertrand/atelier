/** Traduction des erreurs réseau / AI SDK en {@link AtelierError} explicites. */
import { APICallError, RetryError } from 'ai';
import { AtelierError, isAtelierError } from '@atelier/shared';

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Code système d'une erreur réseau Node/undici (éventuellement dans `cause`). */
export function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      if (NETWORK_CODES.has(current.code)) return current.code;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Vrai pour une erreur réseau transitoire (connexion refusée, coupure, DNS…). */
export function isNetworkError(error: unknown): boolean {
  if (networkErrorCode(error) !== undefined) return true;
  return error instanceof TypeError && /fetch failed|network/i.test(error.message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Convertit n'importe quelle erreur du serveur LLM en {@link AtelierError}
 * avec un message français exploitable par l'UI.
 */
export function toLlmError(error: unknown, serverUrl?: string): AtelierError {
  if (isAtelierError(error)) return error;
  const where = serverUrl !== undefined ? ` (${serverUrl})` : '';
  if (RetryError.isInstance(error)) return toLlmError(error.lastError, serverUrl);
  if (isAbortError(error)) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return new AtelierError('llm/timeout', `Le serveur LLM ne répond pas${where}.`, {
        retryable: true,
        cause: error,
      });
    }
    return new AtelierError('agent/aborted', 'Tour annulé.', { cause: error });
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401 || status === 403) {
      return new AtelierError('llm/unauthorized', `Jeton refusé par le serveur LLM${where}.`, {
        cause: error,
        details: { status },
      });
    }
    if (status === 404) {
      return new AtelierError(
        'llm/model_not_found',
        `Modèle introuvable sur le serveur${where}. Vérifiez le nom du modèle (ollama list).`,
        { cause: error, details: { status } },
      );
    }
    if (status === 408 || status === 504) {
      return new AtelierError('llm/timeout', `Délai dépassé côté serveur LLM${where}.`, {
        retryable: true,
        cause: error,
        details: { status },
      });
    }
    if (status === undefined && isNetworkError(error.cause)) {
      return unreachable(where, error);
    }
    return new AtelierError(
      'llm/bad_response',
      `Réponse inattendue du serveur LLM${where}${status !== undefined ? ` (HTTP ${status})` : ''} : ${error.message}`,
      {
        retryable: error.isRetryable,
        cause: error,
        ...(status !== undefined ? { details: { status } } : {}),
      },
    );
  }
  if (isNetworkError(error)) return unreachable(where, error);
  const message = error instanceof Error ? error.message : String(error);
  return new AtelierError('llm/bad_response', `Erreur du serveur LLM${where} : ${message}`, {
    cause: error,
  });
}

function unreachable(where: string, cause: unknown): AtelierError {
  const code = networkErrorCode(cause);
  return new AtelierError(
    'llm/unreachable',
    `Serveur LLM injoignable${where}${code !== undefined ? ` [${code}]` : ''}. Vérifiez l'URL, le VPN/Tailscale et que le serveur tourne.`,
    { retryable: true, cause, ...(code !== undefined ? { details: { networkCode: code } } : {}) },
  );
}
