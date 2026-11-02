/**
 * Test réel (ADR-004 §8) : Silero et Parakeet v3 sur 3 fichiers WAV, à travers
 * le pipeline de dictée complet.
 *
 * Skippé hors macOS arm64 ou sans `ATELIER_VOICE_IT=1`. Les modèles sont lus
 * dans `ATELIER_VOICE_MODELS_DIR` (par défaut le cache du spike S1,
 * `~/.cache/atelier-voice-spike/models`) :
 * - `silero_vad.onnx` ;
 * - `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/` (archive officielle, avec ses
 *   `test_wavs/` : fr, en, de).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE, type TranscriptSegment } from '@atelier/shared';
import type * as Sherpa from 'sherpa-onnx-node';
import { DictationSession } from '../src/dictation.js';
import type { SpeechEngine } from '../src/engine.js';
import { engineLoadConfigSchema } from '../src/protocol.js';
import { createSherpaEngine } from '../src/sherpa.js';
import { detectTextLanguage } from '../src/typography.js';

const enabled =
  process.platform === 'darwin' && process.arch === 'arm64' && process.env.ATELIER_VOICE_IT === '1';

const modelsDir =
  process.env.ATELIER_VOICE_MODELS_DIR ?? join(homedir(), '.cache/atelier-voice-spike/models');
const parakeetDir = join(modelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');

/** Lit un WAV et le ramène en PCM mono 16 kHz, comme le renderer (D3). */
function readWave16k(file: string): Float32Array {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as typeof Sherpa;
  const wave = sherpa.readWave(file);
  if (wave.sampleRate === VOICE_SAMPLE_RATE) return wave.samples;
  return new sherpa.LinearResampler(wave.sampleRate, VOICE_SAMPLE_RATE).flush(wave.samples);
}

/** Dicte un fichier : 0,3 s de silence, l'audio en trames de 100 ms, 0,3 s de silence. */
async function dictateFile(
  engine: SpeechEngine,
  file: string,
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const segments: TranscriptSegment[] = [];
  const session = new DictationSession(
    { voiceSessionId: file, engine },
    { onSegment: (s) => segments.push(s) },
  );
  const pad = new Float32Array(VOICE_FRAME_SAMPLES * 3);
  const audio = readWave16k(file);
  const stream = new Float32Array(pad.length * 2 + audio.length);
  stream.set(audio, pad.length);
  for (let i = 0; i < stream.length; i += VOICE_FRAME_SAMPLES) {
    session.accept(stream.slice(i, i + VOICE_FRAME_SAMPLES));
  }
  const text = await session.stop();
  return { text, segments };
}

/** Textes attendus (décodage glouton, déterministe). */
const EXPECTED = {
  fr: 'Ne vous demandez pas ce que votre pays peut faire pour vous, demandez-vous plutôt ce que vous pouvez faire pour lui.',
  en: 'Ask not what your country can do for you, ask what you can do for your country.',
  de: 'Alles hat ein Ende, nur die Wurst hat zwei.',
} as const;

describe.skipIf(!enabled)('sherpa-onnx réel (Parakeet v3 int8, CPU)', () => {
  it('transcrit 3 fichiers WAV (fr, en, de) à travers le pipeline de dictée', async () => {
    const config = engineLoadConfigSchema.parse({
      vadModel: join(modelsDir, 'silero_vad.onnx'),
      stt: { modelId: 'parakeet-tdt-0.6b-v3-int8', dir: parakeetDir },
    });
    const engine = await createSherpaEngine(config);
    try {
      for (const lang of ['fr', 'en', 'de'] as const) {
        const file = join(parakeetDir, 'test_wavs', `${lang}.wav`);
        const { text, segments } = await dictateFile(engine, file);
        expect(segments.length).toBeGreaterThan(0);
        expect(segments.every((s) => s.final && s.endMs > s.startMs)).toBe(true);
        expect(text).toBe(EXPECTED[lang]);
        expect(detectTextLanguage(text)).toBe(lang === 'fr' ? 'fr' : 'other');
      }
    } finally {
      engine.dispose();
    }
  }, 120_000);
});
