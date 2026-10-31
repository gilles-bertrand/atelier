/**
 * Horloge factice des tests (ADR-002 §6) : le temps n'avance que par `advance`,
 * qui déclenche dans l'ordre les minuteurs arrivés à échéance.
 */
import type { Clock } from './clock.js';

interface Timer {
  at: number;
  seq: number;
  callback: () => void;
}

export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Set<Timer>();

  constructor(start: Date | string) {
    this.#now = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimer(callback: () => void, delayMs: number): () => void {
    const timer = { at: this.#now + Math.max(0, delayMs), seq: (this.#seq += 1), callback };
    this.#timers.add(timer);
    return () => {
      this.#timers.delete(timer);
    };
  }

  /** Minuteurs armés (délai restant de chacun). */
  pending(): number[] {
    return [...this.#timers].map((t) => t.at - this.#now).sort((a, b) => a - b);
  }

  /** Avance le temps en déclenchant les minuteurs échus, et laisse tourner les promesses. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const next = [...this.#timers]
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.#timers.delete(next);
      this.#now = next.at;
      next.callback();
      await flush();
    }
    this.#now = target;
    await flush();
  }

  /** Change l'heure sans déclencher les minuteurs (Mac en veille). */
  jump(ms: number): void {
    this.#now += ms;
  }
}

/** Laisse s'exécuter les promesses en attente. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
