/**
 * Déclaration minimale de `jsdom`, limitée à ce qu'utilise `extract.ts`.
 *
 * `@types/jsdom` n'est volontairement pas installé : il référence `lib.dom`, que
 * Vitest (dont jsdom est un pair optionnel) propagerait alors à tous les packages
 * du monorepo, qui sont compilés sans DOM (`lib: ["ES2023"]`).
 */
declare module 'jsdom' {
  /** Nœud DOM, réduit à ce dont on a besoin. */
  export interface DomNode {
    readonly nodeName: string;
    cloneNode(deep?: boolean): DomNode;
    getAttribute?(name: string): string | null;
  }

  /** Document DOM, réduit à ce dont on a besoin. */
  export interface DomDocument extends DomNode {
    title: string;
    readonly body: DomNode & { innerHTML: string };
  }

  export class VirtualConsole {
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export interface JSDOMOptions {
    url?: string;
    virtualConsole?: VirtualConsole;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: { readonly document: DomDocument; close(): void };
  }
}
