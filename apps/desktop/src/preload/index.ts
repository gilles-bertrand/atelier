import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  type AtelierApi,
  type IpcEventChannel,
  type IpcInvokeChannel,
  type IpcResult,
} from '@atelier/shared';

const invokeChannels = new Set<string>(IPC_INVOKE_CHANNELS);
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
  platform: {
    os: 'darwin',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    appVersion: process.env['npm_package_version'] ?? '0.0.0',
  },
} as AtelierApi;

contextBridge.exposeInMainWorld('atelier', api);
