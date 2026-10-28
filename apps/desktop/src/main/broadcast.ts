import { BrowserWindow } from 'electron';
import type { IpcEventChannel, IpcEventPayload } from '@atelier/shared';

/** Envoie un événement typé (`IpcEventContract`) à toutes les fenêtres ouvertes. */
export function broadcast<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}
