/** Contrat de la voix locale (ADR-004 §5, phases 1 et 2). */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ATELIER_ERROR_CODES,
  DEFAULT_END_OF_TURN_SILENCE_MS,
  DEFAULT_TTS_VOICE,
  DEFAULT_VOICE_SETTINGS,
  MAX_END_OF_TURN_SILENCE_MS,
  MIN_END_OF_TURN_SILENCE_MS,
  VOICE_ECHO_GUARD_MS,
  VOICE_TTS_RATE_MAX,
  VOICE_TTS_RATE_MIN,
  type ChatMessage,
  type IpcEventPayload,
  type IpcRequest,
  type VoiceAudioOut,
  type VoiceInputMode,
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

  it('phase 2 : voix de synthèse non vide', () => {
    expect(validateVoiceSettings({ ...base, ttsVoice: DEFAULT_TTS_VOICE })).toBeUndefined();
    expect(validateVoiceSettings({ ...base, ttsVoice: ' ' })?.field).toBe('ttsVoice');
  });

  it('phase 2 : vitesse de 0,8 à 1,3', () => {
    for (const ttsRate of [VOICE_TTS_RATE_MIN, 1, 1.15, VOICE_TTS_RATE_MAX]) {
      expect(validateVoiceSettings({ ...base, ttsRate })).toBeUndefined();
    }
    for (const ttsRate of [0.79, 1.31, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateVoiceSettings({ ...base, ttsRate })).toEqual({
        field: 'ttsRate',
        message: 'La vitesse de la voix doit être comprise entre 0,8 et 1,3.',
      });
    }
  });

  it('phase 2 : silence de fin de tour, entier de 300 à 3 000 ms (700 par défaut)', () => {
    expect(DEFAULT_END_OF_TURN_SILENCE_MS).toBe(700);
    for (const endOfTurnSilenceMs of [
      MIN_END_OF_TURN_SILENCE_MS,
      DEFAULT_END_OF_TURN_SILENCE_MS,
      MAX_END_OF_TURN_SILENCE_MS,
    ]) {
      expect(validateVoiceSettings({ ...base, endOfTurnSilenceMs })).toBeUndefined();
    }
    for (const endOfTurnSilenceMs of [299, 3_001, 700.5]) {
      expect(validateVoiceSettings({ ...base, endOfTurnSilenceMs })?.field).toBe(
        'endOfTurnSilenceMs',
      );
    }
  });

  it('phase 2 : pas de réglage « interruption à la voix » (semi-duplex, S3)', () => {
    expectTypeOf<VoiceSettings>().not.toHaveProperty('bargeIn');
    expect(VOICE_ECHO_GUARD_MS).toBe(1_500);
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
      'voice:interrupt',
      'voice:playback-ended',
    ] as const) {
      expect(IPC_RENDERER_INVOKE_CHANNELS).toContain(channel);
    }
  });

  it('événements', () => {
    for (const channel of [
      'voice:status',
      'voice:model',
      'voice:transcript',
      'voice:state',
      'voice:audio-out',
    ]) {
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

describe('contrat de la phase 2 (types)', () => {
  it('agent:send et ChatMessage portent le mode de saisie', () => {
    expectTypeOf<IpcRequest<'agent:send'>['inputMode']>().toEqualTypeOf<
      VoiceInputMode | undefined
    >();
    expectTypeOf<ChatMessage['inputMode']>().toEqualTypeOf<VoiceInputMode | undefined>();
  });

  it('voice:audio-out porte le tour, le rang et la fin de réponse', () => {
    expectTypeOf<IpcEventPayload<'voice:audio-out'>>().toEqualTypeOf<VoiceAudioOut>();
    expectTypeOf<VoiceAudioOut>().toHaveProperty('turnId').toEqualTypeOf<string>();
    expectTypeOf<VoiceAudioOut>().toHaveProperty('pcm').toEqualTypeOf<Float32Array>();
  });
});
