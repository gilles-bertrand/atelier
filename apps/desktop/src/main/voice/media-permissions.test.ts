import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isAppUrl,
  isMicrophoneAllowed,
  type AppLocation,
  type PermissionQuery,
} from './media-permissions.js';

const rendererFile = '/Applications/YodAI.app/Contents/Resources/app.asar/out/renderer/index.html';
const production: AppLocation = { rendererFile };
const dev: AppLocation = { rendererFile, devUrl: 'http://localhost:5173/' };
const appUrl = pathToFileURL(rendererFile).href;

const mic = (overrides: Partial<PermissionQuery> = {}): PermissionQuery => ({
  permission: 'media',
  mediaTypes: ['audio'],
  isMainFrame: true,
  requestingUrl: appUrl,
  fromAppWindow: true,
  ...overrides,
});

describe.each([
  ['production', production, appUrl],
  ['dev', dev, 'http://localhost:5173/#/settings'],
])('permissions web en %s (ADR-004 D8)', (_label, location, url) => {
  it('accorde le micro au cadre principal de la fenêtre, à l’URL de l’app', () => {
    expect(isMicrophoneAllowed(mic({ requestingUrl: url }), location)).toBe(true);
  });

  it.each<[string, Partial<PermissionQuery>]>([
    ['la caméra', { mediaTypes: ['video'] }],
    ['micro et caméra ensemble', { mediaTypes: ['audio', 'video'] }],
    ['un type de média inconnu', { mediaTypes: ['unknown'] }],
    ['aucun type de média', { mediaTypes: [] }],
    ['un sous-cadre', { isMainFrame: false }],
    ['un webContents hors fenêtre de l’app', { fromAppWindow: false }],
    ['un aperçu atelier-file:', { requestingUrl: 'atelier-file://preview/x.pdf' }],
    ['un artefact atelier-artifact:', { requestingUrl: 'atelier-artifact://a/index.html' }],
    [
      'la visionneuse PDF',
      { requestingUrl: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html' },
    ],
    ['une page web', { requestingUrl: 'https://example.com/' }],
    ['un autre fichier local', { requestingUrl: 'file:///tmp/page.html' }],
    ['les notifications', { permission: 'notifications', mediaTypes: [] }],
    ['la capture d’écran', { permission: 'display-capture', mediaTypes: [] }],
    ['la géolocalisation', { permission: 'geolocation', mediaTypes: [] }],
  ])('refuse %s', (_name, overrides) => {
    expect(isMicrophoneAllowed(mic({ requestingUrl: url, ...overrides }), location)).toBe(false);
  });
});

describe('isAppUrl', () => {
  it('reconnaît la page packagée, avec ou sans fragment', () => {
    expect(isAppUrl(appUrl, production)).toBe(true);
    expect(isAppUrl(`${appUrl}#/x?y=1`, production)).toBe(true);
  });

  it('n’accepte le serveur de dev qu’en dev, et seulement son origine', () => {
    expect(isAppUrl('http://localhost:5173/', production)).toBe(false);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('http://localhost:5173/a', dev)).toBe(true);
  });

  it('refuse une URL invalide', () => {
    expect(isAppUrl('pas une url', dev)).toBe(false);
  });
});
