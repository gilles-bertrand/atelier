/**
 * Messages de chat tels que l'app les affiche et les persiste (SQLite).
 *
 * Ce ne sont PAS les `ModelMessage` de l'AI SDK : `agent-core` convertit
 * l'historique affiché en messages modèle (et le raisonnement « thinking » n'est
 * jamais réinjecté). Toutes les structures sont sérialisables en JSON.
 */
import type { TodoItem } from './todo.js';

/** Auteur d'un message affiché. */
export type ChatRole = 'user' | 'assistant';

/** Résultat de recherche web (affiché comme lien cliquable). */
export interface WebSearchResult {
  /** Titre de la page. */
  title: string;
  /** URL absolue (http/https). */
  url: string;
  /** Extrait textuel. */
  snippet: string;
}

/** Fichier présenté sous forme de carte cliquable dans le chat. */
export interface FileCard {
  /** Chemin relatif au dossier de travail. */
  path: string;
  /** Chemin absolu côté hôte (pour `shell.openPath`). */
  absolutePath: string;
  /** Type MIME détecté, si connu. */
  mimeType?: string;
  /** Taille en octets. */
  size?: number;
  /** Action à l'origine de la carte. */
  action: 'created' | 'modified' | 'presented';
}

/** Pièce jointe glissée dans le chat, copiée dans `<dossier>/.atelier/uploads/`. */
export interface Attachment {
  /** Chemin relatif au dossier de travail (ex. `.atelier/uploads/facture.pdf`). */
  path: string;
  /** Nom d'origine du fichier. */
  name: string;
  /** Type MIME détecté. */
  mimeType?: string;
  /** Taille en octets. */
  size: number;
}

/**
 * Affichage riche associé à un résultat d'outil (jamais envoyé au modèle).
 * Discriminé par `type`.
 */
export type ToolDisplay =
  | { type: 'file'; file: FileCard }
  | { type: 'web_results'; results: WebSearchResult[] }
  | { type: 'web_page'; url: string; title?: string }
  | { type: 'command'; command: string; exitCode: number; output: string }
  | { type: 'diff'; path: string; before: string; after: string }
  | { type: 'todos'; todos: TodoItem[] };

/** Statut d'un appel d'outil affiché. */
export type ToolCallStatus = 'running' | 'success' | 'error' | 'denied';

/** Partie de message : texte (markdown). */
export interface TextPart {
  type: 'text';
  /** Contenu markdown. */
  text: string;
}

/** Partie de message : raisonnement « thinking », affiché à part et replié. */
export interface ReasoningPart {
  type: 'reasoning';
  /** Texte du raisonnement. */
  text: string;
}

/** Partie de message : appel d'outil et son résultat (bloc repliable). */
export interface ToolCallPart {
  type: 'tool_call';
  /** Identifiant de l'appel (AI SDK). */
  toolCallId: string;
  /** Nom de l'outil. */
  toolName: string;
  /** Entrée validée de l'outil. */
  input: unknown;
  /** Statut courant. */
  status: ToolCallStatus;
  /** Texte renvoyé au modèle (une fois terminé). */
  output?: string;
  /** Affichage riche (carte de fichier, résultats web…). */
  display?: ToolDisplay;
  /** Fichiers produits par l'outil sans carte propre (événement `tool_files`). */
  files?: FileCard[];
}

/** Partie de message : pièce jointe déposée par l'utilisateur. */
export interface AttachmentPart {
  type: 'attachment';
  attachment: Attachment;
}

/** Partie de message : sources citées (badge « Sources »). */
export interface SourcesPart {
  type: 'sources';
  /** URLs consultées ou citées pendant le tour. */
  sources: WebSearchResult[];
}

/** Union des parties possibles d'un message affiché. */
export type MessagePart = TextPart | ReasoningPart | ToolCallPart | AttachmentPart | SourcesPart;

/** Message de chat affiché et persisté. */
export interface ChatMessage {
  /** Identifiant unique. */
  id: string;
  /** Session à laquelle appartient le message. */
  sessionId: string;
  /** Auteur. */
  role: ChatRole;
  /** Contenu ordonné. */
  parts: MessagePart[];
  /** Horodatage ISO 8601. */
  createdAt: string;
}

/** Résumé d'une session pour l'accueil (« sessions récentes »). */
export interface SessionSummary {
  /** Identifiant de la session. */
  id: string;
  /** Titre (dérivé du premier message ou renommé). */
  title: string;
  /** Dossier de travail absolu. */
  workspace: string;
  /** Horodatage ISO 8601 de création. */
  createdAt: string;
  /** Horodatage ISO 8601 de dernière activité. */
  updatedAt: string;
}

/**
 * Relance automatique d'un tour par la boucle agentique (message `[Atelier]`
 * injecté). Les messages `summary` (compaction) et `skill` (autoload) n'en sont
 * pas : ils ne signalent pas un écart du modèle.
 */
export type RelaunchKind =
  | 'continuation'
  | 'stream_cut'
  | 'tool_call_parse'
  | 'empty_final'
  | 'announce_only'
  | 'verification';

/** Liste exhaustive des {@link RelaunchKind}, dans un ordre stable (affichage, SQL). */
export const RELAUNCH_KINDS = [
  'continuation',
  'stream_cut',
  'tool_call_parse',
  'empty_final',
  'announce_only',
  'verification',
] as const satisfies readonly RelaunchKind[];

/**
 * Consommation de tokens d'un tour (pilote la compaction, la jauge de contexte
 * et les KPI d'utilisation, voir `docs/adr/ADR-001-consommation-tokens.md`).
 */
export interface TokenUsage {
  /** Tokens en entrée de la dernière étape. */
  inputTokens: number;
  /** Tokens générés sur le tour. */
  outputTokens: number;
  /** Fenêtre de contexte réelle du modèle (lue via `/api/show`). */
  contextWindow?: number;
  /** Entrée cumulée sur toutes les étapes du tour (tokens réellement traités). */
  totalInputTokens?: number;
  /** Taille du contexte après la dernière étape (entrée + sortie de cette étape) : la jauge. */
  contextTokens?: number;
  /** Nombre d'appels au modèle pendant le tour. */
  steps?: number;
  /** Temps de génération cumulé (premier chunk → fin d'étape), en millisecondes. */
  generationMs?: number;
  /** Relances automatiques du tour, par type (absent = aucune). */
  relaunches?: Partial<Record<RelaunchKind, number>>;
}
