import type { AtelierApi } from '@atelier/shared';

declare global {
  interface Window {
    /** API exposée par le preload (voir `@atelier/shared` › ipc). */
    readonly atelier: AtelierApi;
  }
}

export {};
