/**
 * Indicateur permanent de l'état du serveur LLM : sonde périodique, état
 * `connected` / `slow` / `offline` / `unknown`, notification à chaque changement.
 */
import type { ServerHealth, ServerStatus } from '@atelier/shared';
import type { ServerTarget } from './server-api.js';

/** Au-delà de cette latence, le serveur est jugé « lent ». */
export const SLOW_LATENCY_MS = 1_500;
/** Intervalle entre deux sondes. */
export const PROBE_INTERVAL_MS = 30_000;
/** Intervalle réduit tant que le serveur est hors ligne (reprise plus rapide). */
export const OFFLINE_PROBE_INTERVAL_MS = 10_000;

export interface ServerMonitorOptions {
  /** Cible courante (`undefined` : serveur non configuré). */
  target: () => ServerTarget | undefined;
  /** Sonde (rejette si injoignable). */
  probe: (target: ServerTarget, signal: AbortSignal) => Promise<{ latencyMs: number }>;
  /** Changement d'état. */
  onChange: (status: ServerStatus) => void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Calcule la santé à partir d'une latence (ou d'un échec). */
export function healthFromLatency(latencyMs: number | undefined): ServerHealth {
  if (latencyMs === undefined) return 'offline';
  return latencyMs > SLOW_LATENCY_MS ? 'slow' : 'connected';
}

export class ServerMonitor {
  readonly #o: ServerMonitorOptions;
  #status: ServerStatus;
  #timer: unknown;
  #inFlight: AbortController | undefined;
  #stopped = false;

  constructor(options: ServerMonitorOptions) {
    this.#o = options;
    this.#status = { health: 'unknown', checkedAt: this.#now() };
  }

  status(): ServerStatus {
    return this.#status;
  }

  /** Démarre la sonde (première vérification immédiate). */
  start(): void {
    this.#stopped = false;
    void this.check();
  }

  stop(): void {
    this.#stopped = true;
    this.#clear();
    this.#inFlight?.abort();
  }

  /** Vérifie maintenant (après un changement de réglages, ou à la demande). */
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
    let latencyMs: number | undefined;
    try {
      latencyMs = (await this.#o.probe(target, controller.signal)).latencyMs;
    } catch {
      latencyMs = undefined;
    }
    if (controller.signal.aborted) return this.#status;
    this.#inFlight = undefined;
    const health = healthFromLatency(latencyMs);
    this.#set({
      health,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      checkedAt: this.#now(),
    });
    this.#schedule(health === 'offline' ? OFFLINE_PROBE_INTERVAL_MS : PROBE_INTERVAL_MS);
    return this.#status;
  }

  /** Signale un échec observé ailleurs (tour en erreur réseau) : revérifie tout de suite. */
  reportFailure(): void {
    void this.check();
  }

  #set(next: ServerStatus): void {
    const changed =
      next.health !== this.#status.health || next.latencyMs !== this.#status.latencyMs;
    this.#status = next;
    if (changed) this.#o.onChange(next);
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
