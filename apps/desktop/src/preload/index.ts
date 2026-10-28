import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  IPC_EVENT_CHANNELS,
  IPC_RENDERER_INVOKE_CHANNELS,
  type AtelierApi,
  type IpcEventChannel,
  type IpcInvokeChannel,
  type IpcResult,
} from '@atelier/shared';

// Les canaux réservés au preload (attachment:import) ne sont pas dans cette liste.
const invokeChannels = new Set<string>(IPC_RENDERER_INVOKE_CHANNELS);
const eventChannels = new Set<string>(IPC_EVENT_CHANNELS);

/** API typée exposée au renderer ; seuls les canaux du contrat sont autorisés. */
const api: AtelierApi = {
  invoke(channel: IpcInvokeChannel, ...args: unknown[]) {
    if (!invokeChannels.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'internal', message: `Canal interdit : ${channel}`, retryable: false },
      });
    }
    return ipcRenderer.invoke(channel, args[0]) as Promise<IpcResult<never>>;
  },
  on(channel: IpcEventChannel, listener: (payload: never) => void) {
    if (!eventChannels.has(channel)) return () => undefined;
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(payload as never);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  async importDroppedFiles(sessionId: string, files: readonly File[]) {
    // Seuls des fichiers réellement déposés ont un chemin ; un File construit en
    // mémoire renvoie une chaîne vide.
    const hostPaths = files.map((file) => webUtils.getPathForFile(file)).filter((p) => p !== '');
    if (hostPaths.length === 0 || hostPaths.length !== files.length) {
      return {
        ok: false,
        error: {
          code: 'documents/unsupported_type',
          message: 'Seuls des fichiers présents sur le disque peuvent être déposés.',
          retryable: false,
        },
      };
    }
    return (await ipcRenderer.invoke('attachment:import', {
      sessionId,
      hostPaths,
    })) as IpcResult<never>;
  },
  platform: {
    os: 'darwin',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    appVersion: process.env['npm_package_version'] ?? '0.0.0',
  },
} as AtelierApi;

contextBridge.exposeInMainWorld('atelier', api);
