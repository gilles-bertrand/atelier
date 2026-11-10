import { describe, expect, it } from 'vitest';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from '@atelier/shared';
import { MAX_SPEAK_CHARS, parseMainToWorker, parseWorkerToMain } from '../src/protocol.js';

const load = {
  type: 'load',
  config: {
    vadModel: '/models/silero_vad.onnx',
    stt: { modelId: 'parakeet-tdt-0.6b-v3-int8', dir: '/models/parakeet' },
  },
};

describe('parseMainToWorker', () => {
  it('accepte les messages valides et applique les valeurs par défaut', () => {
    const parsed = parseMainToWorker(load);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'load') {
      expect(parsed.message.config.numThreads).toBe(2);
      expect(parsed.message.config.provider).toBe('cpu');
    }
    const audio = { type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: new Float32Array(1600) };
    expect(parseMainToWorker(audio).ok).toBe(true);
    expect(parseMainToWorker({ type: 'start', voiceSessionId: 'v1' }).ok).toBe(true);
    expect(parseMainToWorker({ type: 'shutdown' }).ok).toBe(true);
  });

  it.each([
    ['type inconnu', { type: 'eval', code: '1' }],
    ['valeur non objet', 'stop'],
    ['champ en trop', { type: 'stop', voiceSessionId: 'v1', extra: true }],
    ['chemin relatif', { ...load, config: { ...load.config, vadModel: 'silero.onnx' } }],
    [
      'chemin avec ..',
      {
        ...load,
        config: { ...load.config, stt: { modelId: 'x', dir: '/models/../etc' } },
      },
    ],
    ['trame non typée', { type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: [0, 0] }],
    ['trame vide', { type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: new Float32Array(0) }],
    [
      'trame trop longue',
      { type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: new Float32Array(VOICE_SAMPLE_RATE + 1) },
    ],
    [
      'échantillon NaN',
      { type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: Float32Array.from([0, Number.NaN]) },
    ],
    [
      'seq négatif',
      { type: 'audio', voiceSessionId: 'v1', seq: -1, pcm: new Float32Array(VOICE_FRAME_SAMPLES) },
    ],
    ['provider inconnu', { ...load, config: { ...load.config, provider: 'gpu' } }],
  ])('rejette un message invalide : %s', (_label, message) => {
    const parsed = parseMainToWorker(message);
    expect(parsed.ok).toBe(false);
  });

  it('ne recopie jamais la valeur fautive', () => {
    const parsed = parseMainToWorker({ type: 'start', voiceSessionId: 'x'.repeat(500) });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issue).toBe('voiceSessionId');
    }
  });
});

describe('parseWorkerToMain', () => {
  it('valide les messages du worker', () => {
    expect(parseWorkerToMain({ type: 'ready' }).ok).toBe(true);
    expect(
      parseWorkerToMain({
        type: 'transcript',
        segment: {
          voiceSessionId: 'v1',
          index: 0,
          text: 'Bonjour.',
          final: true,
          startMs: 0,
          endMs: 900,
        },
      }).ok,
    ).toBe(true);
    expect(
      parseWorkerToMain({
        type: 'error',
        error: { code: 'voice/engine_failed', message: 'x', retryable: true },
      }).ok,
    ).toBe(true);
    expect(
      parseWorkerToMain({ type: 'error', error: { code: 'nope', message: 'x', retryable: true } })
        .ok,
    ).toBe(false);
    expect(parseWorkerToMain({ type: 'state', voiceSessionId: 'v1', state: 'dancing' }).ok).toBe(
      false,
    );
  });
});

describe('protocole de la synthèse (L7)', () => {
  const ttsLoad = { type: 'tts-load', config: { voice: 'supertonic-3-m4', dir: '/models/st' } };

  it('accepte tts-load et speak, avec les valeurs par défaut', () => {
    const parsed = parseMainToWorker(ttsLoad);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'tts-load') {
      expect(parsed.message.config.numThreads).toBe(2);
      expect(parsed.message.config.numSteps).toBeUndefined();
    }
    expect(parseMainToWorker({ type: 'speak', requestId: 0, text: 'Bonjour.', speed: 1 }).ok).toBe(
      true,
    );
  });

  it.each([
    ['dossier relatif', { ...ttsLoad, config: { ...ttsLoad.config, dir: 'models/st' } }],
    ['dossier avec ..', { ...ttsLoad, config: { ...ttsLoad.config, dir: '/models/../etc' } }],
    ['texte vide', { type: 'speak', requestId: 0, text: '', speed: 1 }],
    [
      'texte trop long',
      { type: 'speak', requestId: 0, text: 'a'.repeat(MAX_SPEAK_CHARS + 1), speed: 1 },
    ],
    ['vitesse hors bornes', { type: 'speak', requestId: 0, text: 'Bonjour.', speed: 2 }],
    ['requestId négatif', { type: 'speak', requestId: -1, text: 'Bonjour.', speed: 1 }],
  ])('rejette : %s', (_label, message) => {
    expect(parseMainToWorker(message).ok).toBe(false);
  });

  it('ne recopie jamais le texte refusé', () => {
    const parsed = parseMainToWorker({
      type: 'speak',
      requestId: 0,
      text: 'x'.repeat(5000),
      speed: 1,
    });
    expect(parsed).toEqual({ ok: false, issue: 'text' });
  });

  it('valide les réponses du worker', () => {
    expect(parseWorkerToMain({ type: 'tts-loaded', loadMs: 250, sampleRate: 44_100 }).ok).toBe(
      true,
    );
    expect(
      parseWorkerToMain({
        type: 'speech',
        requestId: 0,
        sampleRate: 44_100,
        pcm: new Float32Array(4),
      }).ok,
    ).toBe(true);
    expect(
      parseWorkerToMain({ type: 'speech', requestId: 0, sampleRate: 44_100, pcm: [0, 0] }).ok,
    ).toBe(false);
    expect(
      parseWorkerToMain({
        type: 'tts-error',
        requestId: 1,
        error: { code: 'voice/engine_failed', message: 'x', retryable: true },
      }).ok,
    ).toBe(true);
    expect(parseWorkerToMain({ type: 'tts-loaded', loadMs: 1, sampleRate: 1 }).ok).toBe(false);
  });
});
