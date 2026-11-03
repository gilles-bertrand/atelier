/**
 * Doublures de la voix pour les tests de composants : fausse capture du micro
 * (jsdom n'a ni micro ni Web Audio) et état de la voix.
 */
import { act } from '@testing-library/react';
import {
  DEFAULT_STT_MODEL,
  type MicAccess,
  type VoiceModelInfo,
  type VoiceStatus,
} from '@atelier/shared';
import type { MicCaptureOptions, StartMicCapture } from '@renderer/features/voice/capture';

export function sttModel(overrides: Partial<VoiceModelInfo> = {}): VoiceModelInfo {
  return {
    id: DEFAULT_STT_MODEL,
    role: 'stt',
    label: 'Parakeet v3 (25 langues européennes)',
    version: '2025-08-16',
    languages: ['fr', 'nl', 'en'],
    downloadBytes: 487_000_000,
    diskBytes: 640_000_000,
    memoryEstimateBytes: 1_500_000_000,
    license: 'CC-BY-4.0',
    bundled: false,
    state: 'installed',
    ...overrides,
  };
}

export function vadModel(): VoiceModelInfo {
  return {
    id: 'silero-vad',
    role: 'vad',
    label: 'Silero VAD (détection de parole)',
    version: '5',
    languages: [],
    downloadBytes: 643_854,
    diskBytes: 643_854,
    memoryEstimateBytes: 20_000_000,
    license: 'MIT',
    bundled: true,
    state: 'installed',
  };
}

export function voiceStatus(
  mic: MicAccess = 'granted',
  stt: Partial<VoiceModelInfo> = {},
): VoiceStatus {
  return { mic, engine: 'stopped', models: [vadModel(), sttModel(stt)] };
}

export interface FakeCapture {
  start: StartMicCapture;
  /** Options du dernier micro ouvert. */
  options: MicCaptureOptions | undefined;
  opened: number;
  stopped: number;
  /** Erreur à lever à la prochaine ouverture. */
  failWith: Error | undefined;
  /** Envoie une trame comme le worklet. */
  frame: (value?: number) => void;
}

export function fakeCapture(): FakeCapture {
  const fake: FakeCapture = {
    options: undefined,
    opened: 0,
    stopped: 0,
    failWith: undefined,
    start: (options) => {
      if (fake.failWith) {
        const error = fake.failWith;
        fake.failWith = undefined;
        return Promise.reject(error);
      }
      fake.options = options;
      fake.opened += 1;
      return Promise.resolve({
        stop: () => {
          fake.stopped += 1;
          return Promise.resolve();
        },
      });
    },
    frame: (value = 0.2) => {
      act(() => {
        fake.options?.onFrame(new Float32Array(1600).fill(value));
      });
    },
  };
  return fake;
}
