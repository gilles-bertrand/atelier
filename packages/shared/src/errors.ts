/**
 * Erreurs typées d'Atelier.
 *
 * Convention du brief : « erreurs typées ». Chaque erreur métier porte un `code`
 * stable (discriminant) qui traverse l'IPC sous forme sérialisable
 * ({@link SerializedAtelierError}) et que l'UI traduit en message français.
 */

/** Codes d'erreur stables, regroupés par domaine (`<domaine>/<cas>`). */
export const ATELIER_ERROR_CODES = [
  // Serveur LLM
  'llm/unreachable',
  'llm/unauthorized',
  'llm/model_not_found',
  'llm/insecure_url',
  'llm/timeout',
  'llm/bad_response',
  /** Le modèle n'a pas une capacité requise (`details.missing: ModelCapability`, ex. `tools`). */
  'llm/model_unsupported',
  // Agent
  'agent/aborted',
  'agent/max_steps',
  'agent/invalid_tool_call',
  /** Un tour est déjà en cours dans cette session. */
  'agent/busy',
  // Sessions et réglages
  /** Session inconnue (supprimée, identifiant invalide). */
  'session/not_found',
  /** Réglage refusé (valeur hors bornes, URL invalide…). */
  'settings/invalid',
  // Tâches planifiées
  /** Tâche refusée (récurrence, durée, dossier…) : `details.field`, message français de `validateSchedule`. */
  'schedule/invalid',
  /** Tâche ou run inconnu (supprimé, identifiant invalide). */
  'schedule/not_found',
  // Outils
  'tool/not_found',
  'tool/invalid_input',
  'tool/path_outside_workspace',
  'tool/not_unique',
  'tool/failed',
  // Sandbox
  'sandbox/virtualization_unavailable',
  'sandbox/disk_full',
  'sandbox/not_ready',
  /** Dossier de travail refusé (racine, `$HOME` complet, données de la VM, skills). */
  'sandbox/invalid_workspace',
  'sandbox/timeout',
  'sandbox/failed',
  // Documents
  'documents/unsupported_type',
  'documents/too_large',
  // Web
  'web/blocked_address',
  'web/fetch_failed',
  'web/search_unavailable',
  // MCP
  'mcp/server_failed',
  'mcp/config_invalid',
  // Divers
  'internal',
] as const;

/** Code d'erreur stable d'Atelier. */
export type AtelierErrorCode = (typeof ATELIER_ERROR_CODES)[number];

/** Forme sérialisable (JSON, IPC) d'une {@link AtelierError}. */
export interface SerializedAtelierError {
  /** Code stable, utilisé pour le routage et la traduction côté UI. */
  code: AtelierErrorCode;
  /** Message technique (non destiné à l'affichage brut). */
  message: string;
  /** Indique si l'opération peut être retentée telle quelle (ex. coupure réseau). */
  retryable: boolean;
  /** Détails optionnels, sérialisables (pas de secrets). */
  details?: Record<string, unknown>;
}

/** Erreur métier d'Atelier, portant un {@link AtelierErrorCode}. */
export class AtelierError extends Error {
  override readonly name = 'AtelierError';
  readonly code: AtelierErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: AtelierErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  /** Convertit l'erreur en objet transportable par l'IPC. */
  toJSON(): SerializedAtelierError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Garde de type pour {@link AtelierError}. */
export function isAtelierError(value: unknown): value is AtelierError {
  return value instanceof AtelierError;
}

/**
 * Normalise n'importe quelle valeur levée en {@link SerializedAtelierError}.
 * Les erreurs inconnues deviennent `internal`.
 */
export function serializeError(error: unknown): SerializedAtelierError {
  if (isAtelierError(error)) return error.toJSON();
  if (error instanceof Error) return { code: 'internal', message: error.message, retryable: false };
  return { code: 'internal', message: String(error), retryable: false };
}
