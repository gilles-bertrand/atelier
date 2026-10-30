/**
 * Dernier usage connu par conversation (jauge de contexte). État isolé du
 * magasin du chat : une mise à jour (au plus une par étape) ne re-rend que la
 * jauge, jamais la liste des messages.
 */
import { type TokenUsage } from '@atelier/shared';
import { createContext, use, useCallback, useSyncExternalStore, type ReactNode } from 'react';

export class SessionUsageStore {
  readonly #usage = new Map<string, TokenUsage>();
  readonly #listeners = new Set<() => void>();

  get(sessionId: string): TokenUsage | undefined {
    return this.#usage.get(sessionId);
  }

  set(sessionId: string, usage: TokenUsage): void {
    this.#usage.set(sessionId, usage);
    for (const listener of this.#listeners) listener();
  }

  forget(sessionId: string): void {
    if (this.#usage.delete(sessionId)) for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

const UsageContext = createContext<SessionUsageStore | null>(null);

export function SessionUsageProvider({
  store,
  children,
}: {
  store: SessionUsageStore;
  children: ReactNode;
}) {
  return <UsageContext value={store}>{children}</UsageContext>;
}

/** Usage de la conversation (`undefined` avant la première réponse). */
export function useSessionUsage(sessionId: string): TokenUsage | undefined {
  const store = use(UsageContext);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => undefined),
    [store],
  );
  return useSyncExternalStore(subscribe, () => store?.get(sessionId));
}
