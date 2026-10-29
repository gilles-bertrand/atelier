/**
 * Messages d'erreur en français, lisibles par un non-développeur, à partir des
 * codes stables d'`AtelierError`. Le message technique n'est jamais affiché tel quel.
 */
import type { AtelierErrorCode, SerializedAtelierError } from '@atelier/shared';

const MESSAGES: Record<AtelierErrorCode, string> = {
  'llm/unreachable': 'Le serveur est injoignable. Vérifiez votre connexion (et votre VPN).',
  'llm/unauthorized': 'Le serveur refuse le jeton d’accès. Vérifiez le token dans les Réglages.',
  'llm/model_not_found': 'Ce modèle n’est pas installé sur le serveur.',
  'llm/insecure_url':
    'Adresse refusée : utilisez https:// (http:// est accepté seulement pour localhost et Tailscale).',
  'llm/timeout': 'Le serveur met trop de temps à répondre.',
  'llm/bad_response': 'Le serveur a répondu de façon inattendue. Est-ce bien un serveur Ollama ?',
  'agent/aborted': 'Arrêté.',
  'agent/max_steps':
    'L’assistant s’est arrêté après trop d’étapes. Reformulez ou découpez la demande.',
  'agent/invalid_tool_call': 'L’assistant a mal formulé une action. Réessayez.',
  'agent/busy': 'L’assistant travaille déjà sur une demande. Attendez la fin ou arrêtez-la.',
  'session/not_found': 'Cette conversation n’existe plus.',
  'settings/invalid': 'Ce réglage n’est pas valide.',
  'tool/not_found': 'Action inconnue.',
  'tool/invalid_input': 'Paramètres d’action invalides.',
  'tool/path_outside_workspace': 'Ce fichier est en dehors du dossier de travail.',
  'tool/not_unique': 'Le passage à modifier apparaît plusieurs fois.',
  'tool/failed': 'L’action a échoué.',
  'sandbox/virtualization_unavailable':
    'La virtualisation n’est pas disponible sur ce Mac (Apple Silicon et macOS 14 requis).',
  'sandbox/disk_full': 'Espace disque insuffisant pour l’environnement d’exécution (10 Go requis).',
  'sandbox/not_ready': 'L’environnement d’exécution n’est pas encore prêt.',
  'sandbox/invalid_workspace':
    'Ce dossier ne peut pas être utilisé : choisissez un dossier précis (ni la racine, ni votre dossier personnel entier).',
  'sandbox/timeout': 'La commande a dépassé le délai autorisé.',
  'sandbox/failed': 'L’environnement d’exécution a rencontré un problème.',
  'documents/unsupported_type': 'Ce type de fichier n’est pas pris en charge.',
  'documents/too_large': 'Ce fichier est trop volumineux.',
  'web/blocked_address': 'Cette adresse web est bloquée par sécurité.',
  'web/fetch_failed': 'La page web n’a pas pu être lue.',
  'web/search_unavailable':
    'La recherche web est indisponible. Configurez un fournisseur dans les Réglages.',
  'mcp/server_failed': 'Un connecteur ne répond pas.',
  'mcp/config_invalid': 'Le fichier de connecteurs (mcp.json) est invalide.',
  internal: 'Une erreur inattendue est survenue.',
};

/** Messages propres à un cas précis (`details.kind`), prioritaires sur le code. */
const KIND_MESSAGES: Record<string, string> = {
  blocked_open:
    'Par sécurité, Atelier n’ouvre directement que les documents (PDF, images, textes, tableurs…). Utilisez « Afficher dans le Finder ».',
};

/** Messages propres à une cause précise (`details.reason`), prioritaires sur le code. */
const REASON_MESSAGES: Record<string, string> = {
  stream_cut:
    'Le serveur a interrompu la réponse avant la fin. Cela arrive quand le texte contient une balise réservée du modèle (<tool_call>). Reformulez la demande sans cette balise, ou demandez de l’écrire « < tool_call> ».',
};

/**
 * Réponse inattendue dont la cause est connue (`details.reason`) mais sans
 * message dédié ici, ni message fourni : le texte générique (« Est-ce bien un
 * serveur Ollama ? ») égarerait l'utilisateur, le serveur est bien Ollama.
 */
const BAD_RESPONSE_WITH_REASON = 'Le serveur a interrompu la réponse de façon inattendue.';

/**
 * Causes pour lesquelles relancer le même tour échouerait de la même façon
 * (agent-core a déjà fait une relance adaptée) : il faut reformuler.
 * - `stream_cut` : flux coupé sur la balise réservée `<tool_call>` (#42) ;
 * - `tool_call_parse` : 500 « EOF » du parseur d'appels d'outils d'Ollama (#69).
 */
const NOT_RETRYABLE_REASONS = new Set(['stream_cut', 'tool_call_parse']);

function detail(error: Pick<SerializedAtelierError, 'details'>, key: string): string | undefined {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Message lisible pour une erreur sérialisée. Le message technique n'est repris
 * que pour un `llm/bad_response` à cause connue sans message dédié ici : agent-core
 * le rédige alors en français pour l'utilisateur.
 */
export function errorMessage(
  error: Pick<SerializedAtelierError, 'code' | 'details'> & { message?: string },
): string {
  const kind = detail(error, 'kind');
  if (kind !== undefined && KIND_MESSAGES[kind]) return KIND_MESSAGES[kind];
  const reason = detail(error, 'reason');
  if (reason !== undefined && REASON_MESSAGES[reason]) return REASON_MESSAGES[reason];
  if (reason !== undefined && error.code === 'llm/bad_response') {
    const message = error.message?.trim();
    return message ? message : BAD_RESPONSE_WITH_REASON;
  }
  return MESSAGES[error.code];
}

/**
 * « Réessayer » a-t-il un sens ? Non quand la même demande échouerait à
 * l'identique ({@link NOT_RETRYABLE_REASONS}) : il faut reformuler. Les
 * autres erreurs gardent le bouton, même non `retryable` : après avoir corrigé
 * le jeton ou le modèle dans les Réglages, rejouer le tour est utile.
 */
export function canRetry(error: Pick<SerializedAtelierError, 'details'>): boolean {
  const reason = detail(error, 'reason');
  return reason === undefined || !NOT_RETRYABLE_REASONS.has(reason);
}
