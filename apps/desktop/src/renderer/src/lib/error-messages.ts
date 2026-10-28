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

/** Message lisible pour une erreur sérialisée. */
export function errorMessage(error: Pick<SerializedAtelierError, 'code'>): string {
  return MESSAGES[error.code];
}
