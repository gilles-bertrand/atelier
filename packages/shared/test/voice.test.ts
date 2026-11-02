/** Contrat de la voix locale (ADR-004 §5, phase 1). */
import { describe, expect, it } from 'vitest';
import {
  ATELIER_ERROR_CODES,
  DEFAULT_VOICE_SETTINGS,
  IPC_EVENT_CHANNELS,
  IPC_RENDERER_INVOKE_CHANNELS,
  MAX_VOICE_GLOSSARY_TERMS,
  VOICE_FRAME_SAMPLES,
  validateVoiceSettings,
  type VoiceSettings,
} from '../src/index.js';

const base: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };

describe('validateVoiceSettings', () => {
  it('accepte les réglages par défaut (voix désactivée, Parakeet, 10 min)', () => {
    expect(DEFAULT_VOICE_SETTINGS.enabled).toBe(false);
    expect(validateVoiceSettings(base)).toBeUndefined();
  });

  it('miroir des modèles : règle de checkServerUrl', () => {
    for (const url of [
      'https://modeles.exemple.fr/voice',
      'http://localhost:8080',
      'http://127.0.0.1:9000/m',
      'http://atelier.tailnet-1234.ts.net',
      'http://100.101.102.103',
      '',
    ]) {
      expect(validateVoiceSettings({ ...base, modelSourceUrl: url })).toBeUndefined();
    }
    expect(validateVoiceSettings({ ...base, modelSourceUrl: 'http://exemple.fr' })).toEqual({
      field: 'modelSourceUrl',
      message:
        'Le miroir des modèles doit être en https:// (http:// seulement pour localhost ou Tailscale).',
    });
    for (const url of ['file:///tmp/modele.tar.bz2', 'pas une url']) {
      expect(validateVoiceSettings({ ...base, modelSourceUrl: url })?.field).toBe('modelSourceUrl');
    }
  });

  it('délai de déchargement : entier de 0 à 1 440 minutes', () => {
    expect(validateVoiceSettings({ ...base, idleUnloadMinutes: 0 })).toBeUndefined();
    for (const idleUnloadMinutes of [-1, 2.5, 1_441, Number.NaN]) {
      expect(validateVoiceSettings({ ...base, idleUnloadMinutes })?.field).toBe(
        'idleUnloadMinutes',
      );
    }
  });

  it('modèle de reconnaissance obligatoire', () => {
    expect(validateVoiceSettings({ ...base, sttModel: ' ' })?.field).toBe('sttModel');
  });

  it('glossaire : termes non vides, bornés en nombre et en longueur', () => {
    expect(validateVoiceSettings({ ...base, glossary: ['Ollama', 'Triptyk'] })).toBeUndefined();
    expect(validateVoiceSettings({ ...base, glossary: ['Ollama', ' '] })?.field).toBe('glossary');
    expect(validateVoiceSettings({ ...base, glossary: ['x'.repeat(61)] })?.field).toBe('glossary');
    const many = Array.from({ length: MAX_VOICE_GLOSSARY_TERMS + 1 }, (_, i) => `mot${String(i)}`);
    expect(validateVoiceSettings({ ...base, glossary: many })?.field).toBe('glossary');
  });
});

describe('contrat IPC de la voix', () => {
  it('trame de 100 ms à 16 kHz', () => {
    expect(VOICE_FRAME_SAMPLES).toBe(1_600);
  });

  it('canaux invocables par le renderer, sans MessagePort ni canal réservé au preload', () => {
    for (const channel of [
      'voice:status',
      'voice:request-mic',
      'voice:open-mic-settings',
      'voice:install-model',
      'voice:cancel-install',
      'voice:remove-model',
      'voice:import-model',
      'voice:start',
      'voice:stop',
      'voice:cancel',
      'voice:audio',
    ] as const) {
      expect(IPC_RENDERER_INVOKE_CHANNELS).toContain(channel);
    }
  });

  it('événements', () => {
    for (const channel of ['voice:status', 'voice:model', 'voice:transcript', 'voice:state']) {
      expect(IPC_EVENT_CHANNELS).toContain(channel);
    }
  });

  it("codes d'erreur", () => {
    for (const code of [
      'voice/mic_denied',
      'voice/no_input',
      'voice/model_missing',
      'voice/model_invalid',
      'voice/download_failed',
      'voice/engine_failed',
      'voice/busy',
    ]) {
      expect(ATELIER_ERROR_CODES).toContain(code);
    }
  });
});
