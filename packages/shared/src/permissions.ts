/**
 * Permissions : un outil sensible demande l'accord de l'utilisateur dans son
 * `execute`, via un {@link PermissionHandler} injecté. Un refus est renvoyé au
 * modèle sous forme de message, jamais sous forme d'exception.
 */

/** Réponse de l'utilisateur dans la modale de permission. */
export type PermissionDecision = 'allow_once' | 'allow_session' | 'deny';

/** Nature de l'action, pour adapter le libellé et l'icône de la modale. */
export type PermissionKind =
  'file_write' | 'file_delete' | 'command' | 'network' | 'mcp_write' | 'other';

/** Demande de permission présentée à l'utilisateur. */
export interface PermissionRequest {
  /** Identifiant unique de la demande (corrèle la réponse). */
  id: string;
  /** Session de chat concernée. */
  sessionId: string;
  /** Appel d'outil à l'origine de la demande. */
  toolCallId: string;
  /** Nom de l'outil (ex. `write_file`, `mcp__github__create_issue`). */
  toolName: string;
  /** Nature de l'action. */
  kind: PermissionKind;
  /** Titre court en français (ex. « Écrire le fichier recap.xlsx »). */
  title: string;
  /** Détail optionnel (commande complète, aperçu du contenu, URL…). */
  detail?: string;
  /**
   * Clé de portée pour « toujours pour cette session » : deux demandes de même
   * `scopeKey` sont couvertes par un `allow_session` (ex. `web_fetch:example.com`,
   * `write_file`, `bash`). Par défaut : `toolName`.
   */
  scopeKey?: string;
  /** Entrée brute de l'outil, pour inspection. */
  input: unknown;
}

/**
 * Partie descriptive d'une {@link PermissionRequest}, celle que seul l'outil sait
 * produire (le reste — `id`, `sessionId`, `toolCallId`, `toolName`, `input` —
 * est complété par `agent-core`). Voir `ToolDefinition.describePermission`.
 */
export type PermissionDescription = Pick<
  PermissionRequest,
  'kind' | 'title' | 'detail' | 'scopeKey'
>;

/**
 * Gestionnaire de permissions injecté dans les outils.
 * Côté app, il ouvre la modale (event `permission_request`) et attend la réponse ;
 * en test ou en CLI, il peut répondre automatiquement.
 * Il mémorise lui-même les `allow_session` pour les `scopeKey` déjà accordées.
 */
export type PermissionHandler = (
  request: PermissionRequest,
  signal?: AbortSignal,
) => Promise<PermissionDecision>;

/** Vrai si la décision autorise l'exécution. */
export function isAllowed(decision: PermissionDecision): boolean {
  return decision !== 'deny';
}
