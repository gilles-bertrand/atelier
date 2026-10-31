/**
 * Protocole `atelier-artifact:` (ADR-003 D5) : sert les versions d'artefacts à
 * la visionneuse, et les bibliothèques fournies localement (Chart.js).
 *
 * - `atelier-artifact://<id>/v<N>/` (ou `/latest/`) : la page de la version ;
 * - `atelier-artifact://lib/<fichier>` : une bibliothèque de la liste blanche.
 *
 * Isolation, en plus de l'`<iframe sandbox="allow-scripts">` du renderer :
 * - CSP `sandbox allow-scripts` : origine opaque même si la page est ouverte seule ;
 * - aucun réseau (`default-src 'none'`, `connect-src 'none'`), aucun formulaire,
 *   aucun cadre ; scripts intégrés et bibliothèques locales seulement ;
 * - le main bloque en plus toute navigation de sous-cadre hors de ce protocole
 *   (`isAllowedSubframeUrl`) : une page piégée ne peut pas s'envoyer vers le web ;
 * - deux canaux échappent à `connect-src` : la prérésolution DNS (des données
 *   codées dans un nom d'hôte) et WebRTC (STUN). Ils sont coupés par
 *   `X-DNS-Prefetch-Control: off` et `webrtc 'block'`, et le main limite WebRTC
 *   aux proxys UDP (`disable_non_proxied_udp`) pour les navigateurs qui ignorent
 *   cette directive.
 */
import { readFile } from 'node:fs/promises';
import { ARTIFACT_SCHEME } from '@atelier/shared';
import type { ArtifactStore } from './artifact-store.js';

/** Hôte réservé aux bibliothèques (les identifiants d'artefacts sont des UUID). */
export const ARTIFACT_LIB_HOST = 'lib';

/** CSP de toute page d'artefact. */
export const ARTIFACT_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  `script-src 'unsafe-inline' ${ARTIFACT_SCHEME}:`,
  "style-src 'unsafe-inline'",
  `img-src data: blob: ${ARTIFACT_SCHEME}:`,
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "webrtc 'block'",
].join('; ');

/** Bibliothèques servies aux artefacts : nom de fichier → chemin sur le disque. */
export type ArtifactLibraries = Readonly<Record<string, string>>;

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function failure(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Version demandée par le chemin : `/v3/` → 3, `/latest/` → `undefined`, sinon `null`. */
export function parseVersionPath(pathname: string): number | undefined | null {
  const match = /^\/(?:v([1-9]\d{0,8})|latest)\/(?:index\.html)?$/.exec(pathname);
  if (!match) return null;
  return match[1] === undefined ? undefined : Number(match[1]);
}

async function serveLibrary(pathname: string, libraries: ArtifactLibraries): Promise<Response> {
  const name = pathname.replace(/^\//, '');
  const file = Object.hasOwn(libraries, name) ? libraries[name] : undefined;
  if (file === undefined) return failure(404, 'Bibliothèque inconnue.');
  try {
    const body = await readFile(file);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'max-age=86400',
      },
    });
  } catch {
    return failure(404, 'Bibliothèque indisponible.');
  }
}

/** Répond à une requête `atelier-artifact://` (I/O : la base des artefacts et les bibliothèques). */
export async function handleArtifactRequest(
  requestUrl: string,
  store: Pick<ArtifactStore, 'content'>,
  libraries: ArtifactLibraries,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return failure(400, 'URL d’artefact invalide.');
  }
  if (url.protocol !== `${ARTIFACT_SCHEME}:` || url.hostname === '') {
    return failure(400, 'URL d’artefact invalide.');
  }
  if (url.hostname === ARTIFACT_LIB_HOST) return serveLibrary(url.pathname, libraries);
  const version = parseVersionPath(url.pathname);
  // Ressources relatives d'une page (V1 : pages autonomes seulement) : refusées.
  if (version === null) return failure(404, 'Ressource introuvable.');
  const found = store.content(decodeURIComponent(url.hostname), version);
  if (!found) return failure(404, 'Artefact ou version introuvable.');
  const html = found.format === 'html';
  return new Response(new Uint8Array(found.content), {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      // Markdown : lu en texte par le renderer, qui le rend lui-même (jamais en HTML brut).
      'Content-Type': html ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
      'Content-Security-Policy': ARTIFACT_CSP,
      'X-DNS-Prefetch-Control': 'off',
      'X-Atelier-Artifact-Version': String(found.version),
      'Access-Control-Expose-Headers': 'X-Atelier-Artifact-Version',
    },
  });
}

/**
 * Navigations de sous-cadre permises : artefacts, aperçu de fichiers, visionneuse
 * PDF de Chromium, documents vides. Tout le reste (`https:`, `file:`…) est bloqué.
 */
export function isAllowedSubframeUrl(url: string, extra: readonly string[] = []): boolean {
  return (
    url.startsWith(`${ARTIFACT_SCHEME}:`) ||
    url === 'about:blank' ||
    url === 'about:srcdoc' ||
    extra.some((prefix) => url.startsWith(prefix))
  );
}
