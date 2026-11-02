/**
 * Permissions web du renderer (ADR-004 D8, §7) : seul le **micro** est accordé,
 * et seulement au **cadre principal** d'une **fenêtre de l'app**, à l'URL de
 * l'app (fichier du renderer en production, serveur Vite en dev). Tout le reste
 * est refusé : caméra, écran, notifications, géolocalisation, sous-cadres
 * (aperçus `atelier-file:`, artefacts `atelier-artifact:`, visionneuse PDF).
 *
 * Fonctions pures : `electron-voice.ts` les branche sur
 * `setPermissionRequestHandler` et `setPermissionCheckHandler`, en dev comme en
 * production (le micro ne doit pas marcher en dev puis être refusé une fois packagé).
 */
import { fileURLToPath } from 'node:url';

/** Où vit le renderer de l'app. */
export interface AppLocation {
  /** Fichier `index.html` du renderer (production). */
  rendererFile: string;
  /** URL du serveur Vite (dev) ; absente en production. */
  devUrl?: string;
}

/** Demande de permission, vue par Electron (requête ou contrôle). */
export interface PermissionQuery {
  permission: string;
  /** Types de média demandés (`details.mediaTypes`, ou `[details.mediaType]` pour un contrôle). */
  mediaTypes: readonly string[];
  isMainFrame: boolean;
  /** URL du cadre demandeur. */
  requestingUrl: string;
  /** Le `webContents` est celui d'une fenêtre de l'app (ni `webview`, ni page externe). */
  fromAppWindow: boolean;
}

/** Vrai si `url` est la page de l'app (renderer packagé ou serveur de dev). */
export function isAppUrl(url: string, location: AppLocation): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (location.devUrl !== undefined) {
    try {
      if (parsed.origin === new URL(location.devUrl).origin && parsed.origin !== 'null')
        return true;
    } catch {
      // URL de dev invalide : seule la page packagée compte.
    }
  }
  if (parsed.protocol !== 'file:') return false;
  try {
    parsed.hash = '';
    parsed.search = '';
    return fileURLToPath(parsed) === location.rendererFile;
  } catch {
    return false;
  }
}

/** Vrai pour la seule permission accordée : le micro, audio seul, à la page de l'app. */
export function isMicrophoneAllowed(query: PermissionQuery, location: AppLocation): boolean {
  if (query.permission !== 'media') return false;
  if (query.mediaTypes.length === 0 || query.mediaTypes.some((type) => type !== 'audio')) {
    return false;
  }
  return query.fromAppWindow && query.isMainFrame && isAppUrl(query.requestingUrl, location);
}
