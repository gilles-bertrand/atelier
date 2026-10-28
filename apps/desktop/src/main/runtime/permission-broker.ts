/**
 * Pont entre le `PermissionHandler` des outils et la modale du renderer.
 *
 * `agent-core` émet l'event `permission_request` (relayé au renderer) puis
 * appelle le gestionnaire : on garde la promesse en attente jusqu'à la réponse
 * `permission:respond`. Un tour annulé (bouton stop) répond `deny`.
 * Les `allow_session` sont mémorisés par session (`withSessionMemory`).
 */
import { withSessionMemory } from '@atelier/agent-core';
import type { PermissionDecision, PermissionHandler, PermissionRequest } from '@atelier/shared';

interface Pending {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

export class PermissionBroker {
  readonly #pending = new Map<string, Pending>();
  readonly #handlers = new Map<string, PermissionHandler>();

  /** Gestionnaire d'une session (mémoire « toujours pour cette session » incluse). */
  handlerFor(sessionId: string): PermissionHandler {
    let handler = this.#handlers.get(sessionId);
    if (!handler) {
      handler = withSessionMemory((request, signal) => this.#ask(request, signal));
      this.#handlers.set(sessionId, handler);
    }
    return handler;
  }

  /** Réponse de l'utilisateur ; renvoie `false` si la demande n'existe plus. */
  respond(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  /** Demandes encore ouvertes (pour réafficher la modale après un rechargement). */
  pending(sessionId?: string): PermissionRequest[] {
    return [...this.#pending.values()]
      .map((p) => p.request)
      .filter((r) => sessionId === undefined || r.sessionId === sessionId);
  }

  /** Refuse toutes les demandes ouvertes d'une session (stop, suppression). */
  denyAll(sessionId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.request.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      pending.resolve('deny');
    }
  }

  /** Oublie une session (mémoire des autorisations comprise). */
  forget(sessionId: string): void {
    this.denyAll(sessionId);
    this.#handlers.delete(sessionId);
  }

  #ask(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
    if (signal?.aborted) return Promise.resolve('deny');
    return new Promise<PermissionDecision>((resolve) => {
      const onAbort = (): void => {
        this.respond(request.id, 'deny');
      };
      this.#pending.set(request.id, {
        request,
        resolve: (decision) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(decision);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
