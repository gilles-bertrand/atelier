/**
 * Accès typé à `window.atelier` (preload). Le renderer n'a jamais accès à Node :
 * tout passe par les canaux du contrat `IpcInvokeContract`.
 */
import type {
  AtelierApi,
  IpcRequest,
  IpcResponse,
  RendererInvokeChannel,
  SerializedAtelierError,
} from '@atelier/shared';

/** API du preload (remplaçable dans les tests via `window.atelier`). */
export function atelier(): AtelierApi {
  return window.atelier;
}

/** Erreur IPC portant l'erreur sérialisée du main (code stable pour la traduction). */
export class IpcError extends Error {
  readonly error: SerializedAtelierError;
  constructor(error: SerializedAtelierError) {
    super(error.message);
    this.name = 'IpcError';
    this.error = error;
  }
}

/**
 * Appelle un canal et renvoie la valeur, ou lève une {@link IpcError}.
 * Pratique dans les gestionnaires d'événements avec `try / catch`.
 */
export async function call<C extends RendererInvokeChannel>(
  channel: C,
  ...args: IpcRequest<C> extends undefined ? [] : [request: IpcRequest<C>]
): Promise<IpcResponse<C>> {
  const result = await atelier().invoke(channel, ...args);
  if (!result.ok) throw new IpcError(result.error);
  return result.value;
}

/** Convertit n'importe quelle erreur attrapée en erreur sérialisée. */
export function toSerializedError(error: unknown): SerializedAtelierError {
  if (error instanceof IpcError) return error.error;
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
