/**
 * Horloge injectée (ADR-002 D1) : les tests du scheduler, du bail et de la
 * durée maximale utilisent des minuteurs factices.
 */
export interface Clock {
  now(): Date;
  /** Arme un minuteur ; la fonction renvoyée l'annule. */
  setTimer(callback: () => void, delayMs: number): () => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};
