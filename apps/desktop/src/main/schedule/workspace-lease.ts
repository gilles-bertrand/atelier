/**
 * Bail sur la machine isolée (ADR-002 D5). Il n'y a qu'une VM, montée sur un
 * seul dossier, et préparer un tour la remonte : deux tours dans des dossiers
 * différents ne peuvent pas la tenir en même temps.
 *
 * Le bail est partagé par dossier : plusieurs détenteurs dans le même dossier
 * cohabitent, un détenteur d'un autre dossier attend que tous soient partis.
 * Les tours interactifs le prennent à chaque tour (attente sans limite, levée
 * par « Arrêter ») ; un run planifié ne le prend que s'il a le droit d'exécuter
 * des commandes, et attend au plus `timeoutMs` avant d'être sauté (`busy`).
 */
import { AtelierError, type SandboxHolder } from '@atelier/shared';
import { systemClock, type Clock } from './clock.js';

/**
 * Détenteur du bail : un run planifié (`runId`, `taskName`) ou une conversation
 * (`sessionId`), publié tel quel dans `SandboxStatus.heldBy`.
 */
export type LeaseHolder = SandboxHolder;

/** Libère le bail ; idempotent. */
export type Release = () => void;

interface Waiter {
  holder: LeaseHolder;
  grant: (release: Release) => void;
}

/** Délai d'attente dépassé : la VM est restée occupée dans un autre dossier. */
export class LeaseBusyError extends AtelierError {
  constructor(workspace: string) {
    super('sandbox/not_ready', 'La machine isolée est occupée dans un autre dossier.', {
      details: { kind: 'lease_busy', workspace },
    });
  }
}

export class WorkspaceLease {
  readonly #holders = new Set<LeaseHolder>();
  readonly #waiters: Waiter[] = [];
  readonly #clock: Clock;
  readonly #onChange: ((holder: SandboxHolder | undefined) => void) | undefined;

  constructor(
    options: {
      clock?: Clock;
      /** Détenteur à afficher, à chaque changement (`SandboxStatus.heldBy`). */
      onChange?: (holder: SandboxHolder | undefined) => void;
    } = {},
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#onChange = options.onChange;
  }

  /** Dossier où la VM est tenue, s'il y a un détenteur. */
  workspace(): string | undefined {
    return this.#holders.values().next().value?.workspace;
  }

  /** Qui tient la VM : un run planifié en priorité (on peut l'arrêter), sinon une conversation. */
  holder(): SandboxHolder | undefined {
    let first: SandboxHolder | undefined;
    for (const holder of this.#holders) {
      if (holder.runId !== undefined) return { ...holder };
      first ??= holder;
    }
    return first ? { ...first } : undefined;
  }

  /** Prend le bail tout de suite si c'est possible. */
  tryAcquire(holder: LeaseHolder): Release | undefined {
    // Même dossier que les détenteurs : jamais d'attente (D5), même si un run
    // d'un autre dossier attend déjà (il sera sauté après son délai).
    if (!this.#compatible(holder.workspace)) return undefined;
    return this.#grant(holder);
  }

  /**
   * Prend le bail, en attendant si la VM est tenue dans un autre dossier.
   * Rejette `agent/aborted` si `signal` est annulé, {@link LeaseBusyError}
   * après `timeoutMs` (sans limite si absent).
   */
  acquire(
    holder: LeaseHolder,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Release> {
    const now = this.tryAcquire(holder);
    if (now) return Promise.resolve(now);
    const { signal, timeoutMs } = options;
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise<Release>((resolve, reject) => {
      let cancelTimer: (() => void) | undefined;
      const waiter: Waiter = {
        holder,
        grant: (release) => {
          cleanup();
          resolve(release);
        },
      };
      const leave = (error: Error): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) return;
        this.#waiters.splice(index, 1);
        cleanup();
        reject(error);
        // Un autre en attente a peut-être été bloqué derrière celui-ci.
        this.#drain();
      };
      const onAbort = (): void => {
        leave(aborted());
      };
      const cleanup = (): void => {
        cancelTimer?.();
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined) {
        cancelTimer = this.#clock.setTimer(() => {
          leave(new LeaseBusyError(holder.workspace));
        }, timeoutMs);
      }
      this.#waiters.push(waiter);
    });
  }

  #compatible(workspace: string): boolean {
    const current = this.workspace();
    return current === undefined || current === workspace;
  }

  #grant(holder: LeaseHolder): Release {
    // Objet propre à ce détenteur : deux tours du même dossier restent distincts.
    const own = { ...holder };
    this.#holders.add(own);
    this.#onChange?.(this.holder());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holders.delete(own);
      this.#onChange?.(this.holder());
      this.#drain();
    };
  }

  /** Sert les attentes dans l'ordre d'arrivée, tant qu'elles sont compatibles. */
  #drain(): void {
    while (this.#waiters.length > 0) {
      const next = this.#waiters[0];
      if (!next || !this.#compatible(next.holder.workspace)) return;
      this.#waiters.shift();
      next.grant(this.#grant(next.holder));
    }
  }
}

function aborted(): AtelierError {
  return new AtelierError('agent/aborted', 'Arrêté pendant l’attente de la machine isolée.');
}
