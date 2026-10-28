/**
 * Stockage des sessions et de leurs messages affichés.
 *
 * Interface volontairement minimale : l'implémentation en mémoire sert aux tests
 * et au démarrage ; la version SQLite (better-sqlite3) la remplace pour
 * l'historique persistant et la reprise de session.
 */
import { AtelierError, type ChatMessage, type SessionSummary } from '@atelier/shared';
import type { ModelMessage } from 'ai';

export interface SessionStore {
  list(limit?: number): SessionSummary[];
  get(sessionId: string): SessionSummary | undefined;
  create(session: SessionSummary): SessionSummary;
  /** Met à jour le titre et/ou la date de dernière activité. */
  update(
    sessionId: string,
    patch: Partial<Pick<SessionSummary, 'title' | 'updatedAt'>>,
  ): SessionSummary;
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
  return new AtelierError('internal', `Session introuvable : ${sessionId}`, {
    details: { kind: 'session_not_found', sessionId },
  });
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionSummary>();
  readonly #messages = new Map<string, ChatMessage[]>();
  readonly #modelHistory = new Map<string, readonly ModelMessage[]>();

  list(limit = 50): SessionSummary[] {
    return [...this.#sessions.values()]
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

  update(
    sessionId: string,
    patch: Partial<Pick<SessionSummary, 'title' | 'updatedAt'>>,
  ): SessionSummary {
    const current = this.#sessions.get(sessionId);
    if (!current) throw sessionNotFound(sessionId);
    const next = { ...current, ...patch };
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
