import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_INVOKE_CHANNELS,
  serializeError,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from '@atelier/shared';

/** Appelant d'un canal : fenêtre et cadre émetteurs (voix : micro réservé au cadre principal). */
export interface IpcCallContext {
  /** Identifiant du `webContents` émetteur. */
  senderId: number;
  /** Cadre principal d'une fenêtre de l'app (ni sous-cadre, ni `webview`). */
  fromMainFrame: boolean;
}

/** Gestionnaire typé d'un canal d'invocation. */
export type IpcHandler<C extends IpcInvokeChannel> = (
  request: IpcRequest<C>,
  /** Toujours fourni par {@link registerIpcHandlers} ; absent dans les tests qui ne s'en servent pas. */
  context?: IpcCallContext,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

function callContext(event: IpcMainInvokeEvent): IpcCallContext {
  const frame = event.senderFrame;
  return {
    senderId: event.sender.id,
    fromMainFrame:
      frame !== null &&
      frame.parent === null &&
      BrowserWindow.fromWebContents(event.sender) !== null,
  };
}

/** Ensemble (partiel) des gestionnaires IPC du main. */
export type IpcHandlers = { [C in IpcInvokeChannel]?: IpcHandler<C> };

/**
 * Enregistre les gestionnaires IPC. Chaque canal du contrat reçoit un
 * gestionnaire ; les canaux non encore implémentés répondent une erreur typée.
 * Aucune exception ne traverse le pont : tout est converti en {@link IpcResult}.
 */
export function registerIpcHandlers(handlers: IpcHandlers): void {
  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, request: unknown): Promise<IpcResult<unknown>> => {
      const handler = handlers[channel] as
        ((req: unknown, context: IpcCallContext) => unknown) | undefined;
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
        return { ok: true, value: await handler(request, callContext(event)) };
      } catch (error) {
        return { ok: false, error: serializeError(error) };
      }
    });
  }
}
