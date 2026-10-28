/**
 * Indicateur permanent de l'état du serveur LLM : sonde périodique
 * (`checkServerHealth` d'agent-core, ne lève jamais), notification à chaque
 * changement de santé ou de latence.
 */
import type { ServerStatus } from '@atelier/shared';

/** Intervalle entre deux sondes. */
export const PROBE_INTERVAL_MS = 30_000;
/** Intervalle réduit tant que le serveur est hors ligne (reprise plus rapide). */
export const OFFLINE_PROBE_INTERVAL_MS = 10_000;

/** Cible de la sonde (token lu au moment de la sonde). */
export interface ServerTarget {
  baseUrl: string;
  token?: string | undefined;
}

export interface ServerMonitorOptions {
  /** Cible courante (`undefined` : serveur non configuré). */
  target: () => ServerTarget | undefined;
  /** Sonde : renvoie l'état (ne doit pas lever). */
  probe: (target: ServerTarget, signal: AbortSignal) => Promise<ServerStatus>;
  /** Changement d'état (santé ou latence). */
  onChange: (status: ServerStatus, previous: ServerStatus) => void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ServerMonitor {
  readonly #o: ServerMonitorOptions;
  #status: ServerStatus;
  #timer: unknown;
  #inFlight: AbortController | undefined;
  #stopped = true;

  constructor(options: ServerMonitorOptions) {
    this.#o = options;
    this.#status = { health: 'unknown', checkedAt: this.#now() };
  }

  status(): ServerStatus {
    return this.#status;
  }

  /** Démarre la sonde périodique (première vérification immédiate). */
  start(): void {
    this.#stopped = false;
    void this.check();
  }

  stop(): void {
    this.#stopped = true;
    this.#clear();
    this.#inFlight?.abort();
  }

  /** Vérifie maintenant (changement de réglages, échec d'un tour, à la demande). */
  async check(): Promise<ServerStatus> {
    this.#clear();
    this.#inFlight?.abort();
    const target = this.#o.target();
    if (!target || target.baseUrl === '') {
      this.#set({ health: 'unknown', checkedAt: this.#now() });
      return this.#status;
    }
    const controller = new AbortController();
    this.#inFlight = controller;
    let next: ServerStatus;
    try {
      next = await this.#o.probe(target, controller.signal);
    } catch {
      next = { health: 'offline', checkedAt: this.#now() };
    }
    if (controller.signal.aborted) return this.#status;
    this.#inFlight = undefined;
    this.#set(next);
    this.#schedule(next.health === 'offline' ? OFFLINE_PROBE_INTERVAL_MS : PROBE_INTERVAL_MS);
    return this.#status;
  }

  #set(next: ServerStatus): void {
    const previous = this.#status;
    this.#status = next;
    if (next.health !== previous.health || next.latencyMs !== previous.latencyMs) {
      this.#o.onChange(next, previous);
    }
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    const set =
      this.#o.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay).unref());
    this.#timer = set(() => void this.check(), ms);
  }

  #clear(): void {
    if (this.#timer === undefined) return;
    const clear =
      this.#o.clearTimer ??
      ((h: unknown) => {
        clearTimeout(h as NodeJS.Timeout);
      });
    clear(this.#timer);
    this.#timer = undefined;
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }
}
