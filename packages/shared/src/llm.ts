/**
 * Connexion au serveur LLM (Ollama distant, exposé en OpenAI-compatible sur `/v1`).
 */
import type { AtelierErrorCode } from './errors.js';

/** Configuration du serveur LLM (Réglages / onboarding). Le token n'y figure pas : il est stocké via `safeStorage`. */
export interface LlmServerConfig {
  /** URL de base du serveur, sans `/v1` (ex. `https://llm.example.com`). */
  baseUrl: string;
  /** Modèle principal (défaut `qwen3.5:35b`). */
  model: string;
  /** Mode « thinking » de Qwen activé. */
  thinking: boolean;
  /** Modèle vision séparé (sinon : modèle principal, multimodal). */
  visionModel?: string;
  /**
   * Fenêtre de contexte forcée. Par défaut, la valeur réelle est lue via `/api/show`
   * (`/v1` ignore `num_ctx`).
   */
  numCtx?: number;
}

/** Modèle par défaut. */
export const DEFAULT_MODEL = 'qwen3.5:35b';
/** Contexte minimal visé côté serveur. */
export const MIN_CONTEXT_WINDOW = 32_768;
/** Seuil de compaction (fraction de la fenêtre de contexte). */
export const COMPACTION_THRESHOLD = 0.75;

/** Profils de modèle proposés selon la RAM du serveur. */
export const MODEL_PROFILES = [
  { model: 'qwen3.5:9b', label: 'Léger (16 Go)', minMemoryGiB: 16 },
  { model: 'qwen3.5:27b', label: 'Équilibré (32 Go)', minMemoryGiB: 32 },
  { model: 'qwen3.5:35b', label: 'Recommandé (32 Go et plus)', minMemoryGiB: 32 },
  { model: 'qwen3.5:122b', label: 'Maximal (96 Go et plus)', minMemoryGiB: 96 },
] as const;

/** Modèle disponible sur le serveur (issu de `/api/tags`). */
export interface LlmModelInfo {
  /** Nom complet (ex. `qwen3.5:35b`). */
  name: string;
  /** Taille sur disque en octets. */
  sizeBytes?: number;
  /** Famille / quantification, si connues. */
  family?: string;
  quantization?: string;
}

/** Résultat du bouton « Tester la connexion ». */
export interface ConnectionTestResult {
  /** Connexion réussie (serveur joignable et token accepté). */
  ok: boolean;
  /** Latence aller-retour en millisecondes. */
  latencyMs?: number;
  /** Version d'Ollama (`/api/version`). */
  serverVersion?: string;
  /** Modèles disponibles (`/api/tags`). */
  models: LlmModelInfo[];
  /** Fenêtre de contexte réelle du modèle choisi (`/api/show`). */
  contextWindow?: number;
  /** Code d'erreur en cas d'échec. */
  errorCode?: AtelierErrorCode;
  /** Message lisible en cas d'échec. */
  errorMessage?: string;
}

/** État de santé du serveur (indicateur permanent). */
export type ServerHealth = 'connected' | 'slow' | 'offline' | 'unknown';

/** Instantané de l'état du serveur. */
export interface ServerStatus {
  /** Santé estimée. */
  health: ServerHealth;
  /** Dernière latence mesurée. */
  latencyMs?: number;
  /** Horodatage ISO 8601 du dernier contrôle. */
  checkedAt: string;
}

/** Résultat de {@link checkServerUrl}. */
export type ServerUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid' | 'insecure_http' | 'unsupported_protocol' };

/**
 * Vrai si l'hôte est une boucle locale (`localhost`, `127.0.0.0/8`, `::1`).
 * @param hostname - `URL.hostname` (les IPv6 sont entre crochets).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const parts = parseIPv4(h);
  return parts !== null && parts[0] === 127;
}

/**
 * Vrai si l'hôte est une adresse Tailscale (CGNAT `100.64.0.0/10`) ou un nom
 * MagicDNS (`*.ts.net`).
 */
export function isTailscaleHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h.endsWith('.ts.net')) return true;
  const parts = parseIPv4(h);
  return parts !== null && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/**
 * Règle de sécurité du brief : l'URL du serveur doit être en `https://`, sauf
 * pour `localhost` et les adresses Tailscale (le tunnel chiffre déjà le trafic).
 */
export function checkServerUrl(raw: string): ServerUrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol !== 'http:') return { ok: false, reason: 'unsupported_protocol' };
  if (isLoopbackHost(url.hostname) || isTailscaleHost(url.hostname)) return { ok: true, url };
  return { ok: false, reason: 'insecure_http' };
}

/** Construit l'URL de l'API OpenAI-compatible (`<base>/v1`). */
export function openAiCompatibleBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
}

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const nums = m.slice(1).map(Number);
  if (nums.some((n) => n > 255)) return null;
  return nums as [number, number, number, number];
}
