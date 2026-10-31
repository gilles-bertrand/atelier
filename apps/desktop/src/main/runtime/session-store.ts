/**
 * Stockage des sessions et de leurs messages affichés.
 *
 * Interface volontairement minimale : l'implémentation en mémoire sert aux tests
 * et au démarrage ; la version SQLite (better-sqlite3) la remplace pour
 * l'historique persistant et la reprise de session.
 */
import { AtelierError, type ChatMessage, type SessionSummary } from '@atelier/shared';
import type { ModelMessage } from 'ai';

/**
 * Modification d'une session. `model: null` efface le modèle choisi : la
 * conversation suit alors le modèle par défaut des Réglages.
 */
export interface SessionPatch {
  title?: string;
  updatedAt?: string;
  model?: string | null;
}

/** Applique un {@link SessionPatch} (fonction pure, partagée par les deux stores). */
export function applySessionPatch(current: SessionSummary, patch: SessionPatch): SessionSummary {
  const { model, ...rest } = patch;
  const next: SessionSummary = { ...current, ...rest };
  if (model === null) delete next.model;
  else if (model !== undefined) next.model = model;
  return next;
}

export interface SessionListOptions {
  /** Inclure les conversations des runs planifiés (exclues des « Récentes », ADR-002 D3). */
  includeScheduled?: boolean;
}

export interface SessionStore {
  list(limit?: number, options?: SessionListOptions): SessionSummary[];
  get(sessionId: string): SessionSummary | undefined;
  create(session: SessionSummary): SessionSummary;
  /** Met à jour le titre, la date de dernière activité et/ou le modèle. */
  update(sessionId: string, patch: SessionPatch): SessionSummary;
  delete(sessionId: string): void;
  messages(sessionId: string): ChatMessage[];
  /** Ajoute ou remplace (même `id`) un message. */
  saveMessage(message: ChatMessage): void;
  /**
   * Historique modèle persisté (`TurnResult.messages` : compaction et paires
   * outil/résultat fidèles), ou `undefined` s'il n'a jamais été enregistré.
   */
  modelHistory(sessionId: string): readonly ModelMessage[] | undefined;
  saveModelHistory(sessionId: string, messages: readonly ModelMessage[]): void;
  close?(): void;
}

/** Erreur « session introuvable ». */
export function sessionNotFound(sessionId: string): AtelierError {
  return new AtelierError('session/not_found', `Session introuvable : ${sessionId}`, {
    details: { sessionId },
  });
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionSummary>();
  readonly #messages = new Map<string, ChatMessage[]>();
  readonly #modelHistory = new Map<string, readonly ModelMessage[]>();

  list(limit = 50, options: SessionListOptions = {}): SessionSummary[] {
    return [...this.#sessions.values()]
      .filter((s) => options.includeScheduled === true || s.scheduledTaskId === undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  get(sessionId: string): SessionSummary | undefined {
    return this.#sessions.get(sessionId);
  }

  create(session: SessionSummary): SessionSummary {
    this.#sessions.set(session.id, session);
    this.#messages.set(session.id, []);
    return session;
  }

  update(sessionId: string, patch: SessionPatch): SessionSummary {
    const current = this.#sessions.get(sessionId);
    if (!current) throw sessionNotFound(sessionId);
    const next = applySessionPatch(current, patch);
    this.#sessions.set(sessionId, next);
    return next;
  }

  delete(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#messages.delete(sessionId);
    this.#modelHistory.delete(sessionId);
  }

  modelHistory(sessionId: string): readonly ModelMessage[] | undefined {
    return this.#modelHistory.get(sessionId);
  }

  saveModelHistory(sessionId: string, messages: readonly ModelMessage[]): void {
    if (!this.#sessions.has(sessionId)) throw sessionNotFound(sessionId);
    this.#modelHistory.set(sessionId, [...messages]);
  }

  messages(sessionId: string): ChatMessage[] {
    return [...(this.#messages.get(sessionId) ?? [])];
  }

  saveMessage(message: ChatMessage): void {
    const list = this.#messages.get(message.sessionId);
    if (!list) throw sessionNotFound(message.sessionId);
    const index = list.findIndex((m) => m.id === message.id);
    if (index >= 0) list[index] = message;
    else list.push(message);
  }
}
