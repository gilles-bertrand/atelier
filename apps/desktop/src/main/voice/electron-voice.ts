/**
 * Branchements Electron de la voix (ADR-004 D2, D8) : `utilityProcess`,
 * autorisation macOS du micro, gestionnaires de permission, sélecteur
 * d'archive. Le reste vit dans `voice-service.ts`, testable sous Node.
 */
import { join } from 'node:path';
import {
  BrowserWindow,
  dialog,
  shell,
  systemPreferences,
  utilityProcess,
  type Session,
} from 'electron';
import type { MicAccess } from '@atelier/shared';
import type { MainToWorkerMessage, WorkerHandle } from '@atelier/voice';
import { isMicrophoneAllowed, type AppLocation } from './media-permissions.js';
import type { MicrophoneAccess } from './voice-service.js';

/** Lance le worker de reconnaissance (`out/main/voice-worker.js`). */
export function spawnVoiceWorker(): WorkerHandle {
  const child = utilityProcess.fork(join(import.meta.dirname, 'voice-worker.js'), [], {
    serviceName: 'YodAI Voice',
    stdio: 'ignore',
  });
  return {
    postMessage: (message: MainToWorkerMessage) => {
      child.postMessage(message);
    },
    onMessage: (listener) => {
      child.on('message', (data: unknown) => {
        listener(data);
      });
    },
    onExit: (listener) => {
      child.on('exit', listener);
    },
    kill: () => {
      child.kill();
    },
  };
}

const MIC_ACCESS: readonly MicAccess[] = ['granted', 'denied', 'not-determined', 'restricted'];

function micStatus(): MicAccess {
  if (process.platform !== 'darwin') return 'unknown';
  const status: string = systemPreferences.getMediaAccessStatus('microphone');
  return MIC_ACCESS.find((access) => access === status) ?? 'unknown';
}

/** Autorisation macOS du micro. La demande n'a lieu que sur une action de l'utilisateur. */
export const macMicrophone: MicrophoneAccess = {
  status: micStatus,
  request: async () => {
    if (process.platform !== 'darwin') return 'unknown';
    const current = micStatus();
    // Déjà refusé : macOS ne redemande pas, il faut passer par les Réglages Système.
    if (current !== 'not-determined') return current;
    await systemPreferences.askForMediaAccess('microphone');
    return micStatus();
  },
  openSettings: async () => {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
  },
};

/** Sélecteur de l'archive d'un modèle (import hors ligne). */
export async function chooseModelArchive(): Promise<string | null> {
  const window = BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogOptions = {
    title: 'Importer le modèle de reconnaissance',
    buttonLabel: 'Importer',
    properties: ['openFile'],
    filters: [{ name: 'Archive du modèle', extensions: ['bz2', 'tar', 'gz'] }],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * Gestionnaires de permission (D8), installés **en dev comme en production** :
 * micro seulement, cadre principal d'une fenêtre de l'app, à l'URL de l'app.
 */
export function installPermissionHandlers(target: Session, location: AppLocation): void {
  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    callback(
      isMicrophoneAllowed(
        {
          permission,
          mediaTypes,
          isMainFrame: details.isMainFrame,
          requestingUrl: details.requestingUrl,
          fromAppWindow: BrowserWindow.fromWebContents(webContents) !== null,
        },
        location,
      ),
    );
  });
  target.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    const requestingUrl =
      details.requestingUrl ?? (details.isMainFrame ? webContents?.getURL() : undefined);
    return isMicrophoneAllowed(
      {
        permission,
        mediaTypes: details.mediaType !== undefined ? [details.mediaType] : [],
        isMainFrame: details.isMainFrame,
        requestingUrl: requestingUrl ?? '',
        fromAppWindow: webContents !== null && BrowserWindow.fromWebContents(webContents) !== null,
      },
      location,
    );
  });
}
