/**
 * Adaptateur sherpa-onnx pour la synthèse (ADR-004 D4, L7) : Supertonic 3 int8,
 * style M4, 8 étapes, sur le CPU (2 threads, S2).
 *
 * Supertonic lit le texte brut : aucun phonémiseur, donc ni espeak-ng ni
 * `piper-phonemize-node` (GPL, exclus par D5). Le texte reçu est déjà filtré
 * et découpé en phrases par le main ; une génération rend l'audio d'un bloc.
 *
 * Le module natif est chargé à la création, jamais à l'import. L'audio reste
 * en mémoire : rien n'est écrit sur le disque, et le texte n'est pas journalisé.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AtelierError } from '@atelier/shared';
import type * as Sherpa from 'sherpa-onnx-node';
import { findTtsVoice, type TtsVoice } from './catalog.js';
import type { SpeechSynthesizer, SynthesisOptions } from './engine.js';
import type { TtsLoadConfig } from './protocol.js';

/** Surface du module `sherpa-onnx-node` utilisée ici (injectable en test). */
export type SherpaTtsModule = Pick<typeof Sherpa, 'OfflineTts' | 'GenerationConfig'>;

/** Fichiers d'un modèle Supertonic, relatifs à son dossier installé. */
type SupertonicLayout = Sherpa.OfflineTtsSupertonicModelConfig;

/** Modèles de synthèse pris en charge par l'adaptateur. */
export const SHERPA_TTS_MODELS: Readonly<Record<string, SupertonicLayout>> = {
  'supertonic-3-tts-int8': {
    durationPredictor: 'duration_predictor.int8.onnx',
    textEncoder: 'text_encoder.int8.onnx',
    vectorEstimator: 'vector_estimator.int8.onnx',
    vocoder: 'vocoder.int8.onnx',
    ttsJson: 'tts.json',
    unicodeIndexer: 'unicode_indexer.bin',
    voiceStyle: 'voice.bin',
  },
};

export interface SherpaTtsDeps {
  /** Module natif ; `sherpa-onnx-node` par défaut. */
  loadModule?: () => SherpaTtsModule;
  /** Présence d'un fichier ; `existsSync` par défaut. */
  fileExists?: (path: string) => boolean;
  /** Voix connues ; `TTS_VOICES` par défaut. */
  voices?: readonly TtsVoice[];
}

function defaultLoadModule(): SherpaTtsModule {
  const require = createRequire(import.meta.url);
  return require('sherpa-onnx-node') as SherpaTtsModule;
}

/** Voix et fichiers du modèle, ou `voice/model_invalid` / `voice/model_missing`. */
export function resolveTtsModel(
  config: TtsLoadConfig,
  deps: Pick<SherpaTtsDeps, 'fileExists' | 'voices'> = {},
): { voice: TtsVoice; files: Record<keyof SupertonicLayout, string> } {
  const voice = findTtsVoice(config.voice, deps.voices);
  const layout = voice === undefined ? undefined : SHERPA_TTS_MODELS[voice.modelId];
  if (voice === undefined || layout === undefined) {
    throw new AtelierError(
      'voice/model_invalid',
      'Cette voix de synthèse n’est pas prise en charge par le moteur.',
      { details: { voice: config.voice } },
    );
  }
  const files: Record<keyof SupertonicLayout, string> = {
    durationPredictor: join(config.dir, layout.durationPredictor),
    textEncoder: join(config.dir, layout.textEncoder),
    vectorEstimator: join(config.dir, layout.vectorEstimator),
    vocoder: join(config.dir, layout.vocoder),
    ttsJson: join(config.dir, layout.ttsJson),
    unicodeIndexer: join(config.dir, layout.unicodeIndexer),
    voiceStyle: join(config.dir, layout.voiceStyle),
  };
  const fileExists = deps.fileExists ?? existsSync;
  const missing = Object.values(files).filter((f) => !fileExists(f));
  if (missing.length > 0) {
    throw new AtelierError(
      'voice/model_missing',
      'Le modèle de synthèse vocale est incomplet : téléchargez-le de nouveau.',
      { details: { missing: missing.map((f) => f.split('/').pop() ?? f) } },
    );
  }
  return { voice, files };
}

/** Charge la voix ; rend un {@link SpeechSynthesizer}. */
export async function createSherpaSynthesizer(
  config: TtsLoadConfig,
  deps: SherpaTtsDeps = {},
): Promise<SpeechSynthesizer> {
  const { voice, files } = resolveTtsModel(config, deps);
  const sherpa = (deps.loadModule ?? defaultLoadModule)();
  let tts: Sherpa.OfflineTts | undefined = await sherpa.OfflineTts.createAsync({
    model: { supertonic: files, numThreads: config.numThreads, provider: 'cpu', debug: false },
    // Le main envoie une phrase à la fois (découpage D7).
    maxNumSentences: 1,
  });
  const sampleRate = tts.sampleRate;
  const numSteps = config.numSteps ?? voice.numSteps;

  return {
    sampleRate,
    synthesize: async (text: string, options: SynthesisOptions): Promise<Float32Array> => {
      if (tts === undefined) {
        throw new AtelierError('voice/engine_failed', 'Le moteur de synthèse est arrêté.');
      }
      const audio = await tts.generateAsync({
        text,
        generationConfig: new sherpa.GenerationConfig({
          sid: voice.sid,
          speed: options.speed,
          numSteps,
          extra: { lang: voice.lang },
        }),
      });
      // Copie indépendante du tampon natif, transférable au main.
      return new Float32Array(audio.samples);
    },
    dispose: () => {
      // Libéré par le ramasse-miettes ; l'arrêt du process rend toute la mémoire.
      tts = undefined;
    },
  };
}
