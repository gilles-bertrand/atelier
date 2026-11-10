/**
 * Adaptateur sherpa-onnx (ADR-004 D2, D4) : détection de parole Silero, puis
 * reconnaissance Parakeet TDT 0.6B v3 int8, sur le CPU.
 *
 * Réglages repris du spike S1 (#25) : Silero à 0,5, 0,25 s de parole minimum,
 * 0,6 s de silence pour fermer un segment, 20 s au plus par segment ;
 * Parakeet sur 2 threads CPU. CoreML est écarté par S1 (pas plus rapide, pic
 * mémoire de 5,4 Go) mais reste sélectionnable pour une mesure.
 *
 * Le module natif est chargé à la création du moteur, jamais à l'import : les
 * tests et les plateformes sans binaire n'en ont pas besoin.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AtelierError, VOICE_SAMPLE_RATE } from '@atelier/shared';
import type * as Sherpa from 'sherpa-onnx-node';
import type {
  RecognitionResult,
  SpeechAudioSegment,
  SpeechEngine,
  SpeechSegmenter,
} from './engine.js';
import type { EngineLoadConfig } from './protocol.js';

/** Surface du module `sherpa-onnx-node` utilisée ici (injectable en test). */
export type SherpaModule = Pick<typeof Sherpa, 'OfflineRecognizer' | 'Vad'>;

/** Fichiers d'un modèle de reconnaissance, relatifs à son dossier installé. */
interface SttModelLayout {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  modelType: string;
}

/** Modèles de reconnaissance pris en charge par l'adaptateur. */
export const SHERPA_STT_MODELS: Readonly<Record<string, SttModelLayout>> = {
  'parakeet-tdt-0.6b-v3-int8': {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    joiner: 'joiner.int8.onnx',
    tokens: 'tokens.txt',
    modelType: 'nemo_transducer',
  },
};

/** Réglages du détecteur de parole (S1). */
export const SILERO_VAD_SETTINGS = {
  threshold: 0.5,
  minSpeechDuration: 0.25,
  minSilenceDuration: 0.6,
  maxSpeechDuration: 20,
  windowSize: 512,
} as const;

/** Tampon interne du détecteur, en secondes : couvre le plus long segment. */
const VAD_BUFFER_SECONDS = 60;

export interface SherpaEngineDeps {
  /** Module natif ; `sherpa-onnx-node` par défaut. */
  loadModule?: () => SherpaModule;
  /** Présence d'un fichier ; `existsSync` par défaut. */
  fileExists?: (path: string) => boolean;
}

function defaultLoadModule(): SherpaModule {
  const require = createRequire(import.meta.url);
  return require('sherpa-onnx-node') as SherpaModule;
}

/** Fichiers du modèle, ou `voice/model_missing` / `voice/model_invalid`. */
export function resolveSttModel(
  config: EngineLoadConfig,
  fileExists: (path: string) => boolean = existsSync,
): Sherpa.OfflineModelConfig {
  const layout = SHERPA_STT_MODELS[config.stt.modelId];
  if (layout === undefined) {
    throw new AtelierError(
      'voice/model_invalid',
      'Ce modèle de reconnaissance n’est pas pris en charge par le moteur.',
      { details: { modelId: config.stt.modelId } },
    );
  }
  const files = {
    encoder: join(config.stt.dir, layout.encoder),
    decoder: join(config.stt.dir, layout.decoder),
    joiner: join(config.stt.dir, layout.joiner),
    tokens: join(config.stt.dir, layout.tokens),
  };
  const missing = [config.vadModel, ...Object.values(files)].filter((f) => !fileExists(f));
  if (missing.length > 0) {
    throw new AtelierError(
      'voice/model_missing',
      'Le modèle de reconnaissance est incomplet : téléchargez-le de nouveau.',
      { details: { missing: missing.map((f) => f.split('/').pop() ?? f) } },
    );
  }
  return {
    transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
    tokens: files.tokens,
    modelType: layout.modelType,
    numThreads: config.numThreads,
    provider: config.provider,
    debug: 0,
  };
}

/** Découpeur Silero : un détecteur neuf par session. */
class SileroSegmenter implements SpeechSegmenter {
  private vad: Sherpa.Vad | undefined;

  constructor(vad: Sherpa.Vad) {
    this.vad = vad;
  }

  accept(pcm: Float32Array): SpeechAudioSegment[] {
    if (this.vad === undefined) return [];
    this.vad.acceptWaveform(pcm);
    return this.drain();
  }

  flush(): SpeechAudioSegment[] {
    if (this.vad === undefined) return [];
    this.vad.flush();
    return this.drain();
  }

  speaking(): boolean {
    return this.vad?.isDetected() ?? false;
  }

  dispose(): void {
    this.vad?.clear();
    this.vad = undefined;
  }

  private drain(): SpeechAudioSegment[] {
    const vad = this.vad;
    if (vad === undefined) return [];
    const segments: SpeechAudioSegment[] = [];
    while (!vad.isEmpty()) {
      // `false` : copie indépendante du tampon natif, libérée par le pipeline.
      const segment = vad.front(false);
      vad.pop();
      segments.push({ startSample: segment.start, samples: new Float32Array(segment.samples) });
    }
    return segments;
  }
}

/** Charge Silero et le modèle de reconnaissance ; rend un {@link SpeechEngine}. */
export async function createSherpaEngine(
  config: EngineLoadConfig,
  deps: SherpaEngineDeps = {},
): Promise<SpeechEngine> {
  const modelConfig = resolveSttModel(config, deps.fileExists);
  const sherpa = (deps.loadModule ?? defaultLoadModule)();
  const vadConfig: Sherpa.VadConfig = {
    sileroVad: { model: config.vadModel, ...SILERO_VAD_SETTINGS },
    sampleRate: VOICE_SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  };
  // Le détecteur est vérifié dès le chargement : un fichier corrompu échoue ici.
  new sherpa.Vad(vadConfig, VAD_BUFFER_SECONDS).clear();

  let recognizer: Sherpa.OfflineRecognizer | undefined = await sherpa.OfflineRecognizer.createAsync(
    {
      featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
      modelConfig,
    },
  );

  return {
    createSegmenter: () => new SileroSegmenter(new sherpa.Vad(vadConfig, VAD_BUFFER_SECONDS)),
    transcribe: async (samples: Float32Array): Promise<RecognitionResult> => {
      if (recognizer === undefined) {
        throw new AtelierError('voice/engine_failed', 'Le moteur de reconnaissance est arrêté.');
      }
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples });
      const result = await recognizer.decodeAsync(stream);
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      return typeof result.lang === 'string' && result.lang !== ''
        ? { text, lang: result.lang }
        : { text };
    },
    dispose: () => {
      // Les objets natifs sont libérés par le ramasse-miettes ; l'arrêt du
      // process (inactivité) rend toute la mémoire.
      recognizer = undefined;
    },
  };
}
