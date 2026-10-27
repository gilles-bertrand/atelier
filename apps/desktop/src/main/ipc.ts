import { ipcMain } from 'electron';
import {
  IPC_INVOKE_CHANNELS,
  serializeError,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from '@atelier/shared';

/** Gestionnaire typé d'un canal d'invocation. */
export type IpcHandler<C extends IpcInvokeChannel> = (
  request: IpcRequest<C>,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/** Ensemble (partiel) des gestionnaires IPC du main. */
export type IpcHandlers = { [C in IpcInvokeChannel]?: IpcHandler<C> };

/**
 * Enregistre les gestionnaires IPC. Chaque canal du contrat reçoit un
 * gestionnaire ; les canaux non encore implémentés répondent une erreur typée.
 * Aucune exception ne traverse le pont : tout est converti en {@link IpcResult}.
 */
export function registerIpcHandlers(handlers: IpcHandlers): void {
  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (_event, request: unknown): Promise<IpcResult<unknown>> => {
      const handler = handlers[channel] as ((req: unknown) => unknown) | undefined;
      if (!handler) {
        return {
          ok: false,
          error: {
            code: 'internal',
            message: `Canal non implémenté : ${channel}`,
            retryable: false,
          },
        };
      }
      try {
        return { ok: true, value: await handler(request) };
      } catch (error) {
        return { ok: false, error: serializeError(error) };
      }
    });
  }
}
