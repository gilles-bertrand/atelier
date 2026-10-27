/**
 * Événements émis par la boucle agentique (`agent-core`) pendant un tour.
 *
 * `agent-core` mappe le `fullStream` de l'AI SDK vers ces événements ; le process
 * main les relaie tels quels au renderer (canal IPC `agent:event`). Union
 * discriminée par `type`, entièrement sérialisable.
 */
import type { SerializedAtelierError } from './errors.js';
import type { ToolDisplay, TokenUsage, WebSearchResult } from './messages.js';
import type { PermissionRequest } from './permissions.js';
import type { TodoItem } from './todo.js';

/** Champs communs à tous les événements. */
interface AgentEventBase {
  /** Session de chat. */
  sessionId: string;
  /** Tour (une requête utilisateur → une réponse complète). */
  turnId: string;
}

/** Fragment de texte de la réponse en streaming. */
export interface TextDeltaEvent extends AgentEventBase {
  type: 'text_delta';
  /** Texte à ajouter. */
  delta: string;
}

/**
 * Fragment de raisonnement (mode thinking). Affiché à part, jamais réinjecté
 * dans l'historique envoyé au modèle.
 */
export interface ReasoningDeltaEvent extends AgentEventBase {
  type: 'reasoning_delta';
  delta: string;
}

/** Début d'exécution d'un outil (entrée validée). */
export interface ToolStartEvent extends AgentEventBase {
  type: 'tool_start';
  toolCallId: string;
  toolName: string;
  /** Entrée de l'outil. */
  input: unknown;
}

/** Fin d'exécution d'un outil. */
export interface ToolResultEvent extends AgentEventBase {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  /** Succès (faux aussi pour un refus de permission). */
  ok: boolean;
  /** Vrai si l'utilisateur a refusé la permission. */
  denied?: boolean;
  /** Texte renvoyé au modèle (éventuellement tronqué pour l'UI). */
  output: string;
  /** Affichage riche (carte de fichier, résultats web…). */
  display?: ToolDisplay;
}

/** Nouvelle liste de tâches (après `todo_write`). */
export interface TodoUpdateEvent extends AgentEventBase {
  type: 'todo_update';
  todos: TodoItem[];
}

/** Demande de permission : l'UI ouvre la modale et répond via `permission:respond`. */
export interface PermissionRequestEvent extends AgentEventBase {
  type: 'permission_request';
  request: PermissionRequest;
}

/** Sources web collectées pendant le tour (badge « Sources »). */
export interface SourcesEvent extends AgentEventBase {
  type: 'sources';
  sources: WebSearchResult[];
}

/** L'historique a été compacté (résumé des anciens messages). */
export interface CompactionEvent extends AgentEventBase {
  type: 'compaction';
  /** Nombre de messages remplacés par le résumé. */
  replacedMessages: number;
}

/** Raison de fin d'un tour. */
export type DoneReason = 'stop' | 'aborted' | 'max_steps' | 'length';

/** Fin normale (ou annulée) du tour. */
export interface DoneEvent extends AgentEventBase {
  type: 'done';
  reason: DoneReason;
  /** Consommation de tokens. */
  usage?: TokenUsage;
}

/** Erreur fatale du tour (serveur injoignable, etc.). Le tour peut être relancé si `retryable`. */
export interface ErrorEvent extends AgentEventBase {
  type: 'error';
  error: SerializedAtelierError;
}

/** Union de tous les événements de l'agent. */
export type AgentEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolStartEvent
  | ToolResultEvent
  | TodoUpdateEvent
  | PermissionRequestEvent
  | SourcesEvent
  | CompactionEvent
  | DoneEvent
  | ErrorEvent;

/** Type discriminant d'un {@link AgentEvent}. */
export type AgentEventType = AgentEvent['type'];

/** Récepteur d'événements injecté dans la boucle. */
export type AgentEventSink = (event: AgentEvent) => void;
