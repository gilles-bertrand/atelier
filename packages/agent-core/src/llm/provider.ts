/**
 * Création du modèle AI SDK pointé sur le serveur Ollama distant (API
 * OpenAI-compatible `/v1`), avec jeton Bearer, nouvelles tentatives, gestion du
 * mode « thinking » et middlewares de robustesse.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import { AtelierError, checkServerUrl, openAiCompatibleBaseUrl } from '@atelier/shared';
import { createRetryingFetch, type FetchFunction, type RetryOptions } from './retry-fetch.js';
import { textToolCallMiddleware } from '../loop/text-tool-calls.js';

export interface LlmConnectionOptions {
  /** URL de base du serveur, sans `/v1` (ex. `https://llm.example.com`). */
  baseUrl: string;
  /** Nom du modèle (ex. `qwen3.5:35b`). */
  model: string;
  /** Jeton Bearer (Caddy). Facultatif en localhost / Tailscale. */
  token?: string;
  /** Mode thinking de Qwen (défaut : activé). */
  thinking?: boolean;
  /** Options de nouvelles tentatives (réseau, 429/502/503/504). */
  retry?: RetryOptions;
  /** `fetch` de base (tests). */
  fetch?: FetchFunction;
}

export interface LlmModels {
  /** Modèle principal (thinking selon réglage). */
  model: LanguageModel;
  /** Même modèle, thinking coupé : résumés de compaction, tâches courtes. */
  fastModel: LanguageModel;
  /** URL effective de l'API (`…/v1`). */
  apiBaseUrl: string;
}

/**
 * Corps de requête modifié pour couper le raisonnement de Qwen :
 * `reasoning_effort: "none"` (Ollama) et `chat_template_kwargs.enable_thinking`
 * (vLLM / templates Qwen).
 */
export function disableThinking(body: Record<string, unknown>): Record<string, unknown> {
  const kwargs =
    typeof body['chat_template_kwargs'] === 'object' && body['chat_template_kwargs'] !== null
      ? (body['chat_template_kwargs'] as Record<string, unknown>)
      : {};
  return {
    ...body,
    reasoning_effort: 'none',
    chat_template_kwargs: { ...kwargs, enable_thinking: false },
  };
}

/** Crée les modèles AI SDK pour une connexion. */
export function createLlmModels(options: LlmConnectionOptions): LlmModels {
  const check = checkServerUrl(options.baseUrl);
  if (!check.ok) {
    throw new AtelierError(
      check.reason === 'insecure_http' ? 'llm/insecure_url' : 'llm/unreachable',
      check.reason === 'insecure_http'
        ? 'URL refusée : utilise https://, ou http:// uniquement pour localhost ou une adresse Tailscale.'
        : `URL du serveur invalide : ${options.baseUrl}`,
    );
  }
  const apiBaseUrl = openAiCompatibleBaseUrl(options.baseUrl);
  const fetch = createRetryingFetch({
    ...options.retry,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const make = (thinking: boolean): LanguageModel => {
    const provider = createOpenAICompatible({
      name: 'ollama',
      baseURL: apiBaseUrl,
      ...(options.token !== undefined && options.token !== '' ? { apiKey: options.token } : {}),
      includeUsage: true,
      fetch,
      ...(thinking ? {} : { transformRequestBody: disableThinking }),
    });
    return wrapLanguageModel({
      model: provider.chatModel(options.model),
      // Le premier middleware est le plus externe : le repli d'appels d'outils voit
      // le texte une fois le raisonnement <think>…</think> extrait (certains
      // serveurs le laissent passer dans le contenu).
      middleware: [textToolCallMiddleware(), extractReasoningMiddleware({ tagName: 'think' })],
    });
  };
  const thinking = options.thinking ?? true;
  const model = make(thinking);
  return { model, fastModel: thinking ? make(false) : model, apiBaseUrl };
}
