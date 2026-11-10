import { describe, expect, it } from 'vitest';
import { AtelierError } from '@atelier/shared';
import type * as Sherpa from 'sherpa-onnx-node';
import { SUPERTONIC_3_INT8, SUPERTONIC_NUM_STEPS, TTS_VOICES } from '../src/catalog.js';
import { ttsLoadConfigSchema } from '../src/protocol.js';
import {
  SHERPA_TTS_MODELS,
  createSherpaSynthesizer,
  resolveTtsModel,
  type SherpaTtsModule,
} from '../src/sherpa-tts.js';

const config = ttsLoadConfigSchema.parse({ voice: 'supertonic-3-m4', dir: '/models/st' });

/** Faux module natif : enregistre les configurations reçues. */
function fakeModule() {
  const calls: {
    tts?: Sherpa.OfflineTtsConfig;
    requests: Sherpa.TtsRequest[];
    gens: Sherpa.GenerationConfigOptions[];
  } = {
    requests: [],
    gens: [],
  };
  class GenerationConfig {
    readonly options: Sherpa.GenerationConfigOptions;
    constructor(options: Sherpa.GenerationConfigOptions) {
      this.options = options;
      calls.gens.push(options);
    }
  }
  const module = {
    GenerationConfig,
    OfflineTts: {
      createAsync: (cfg: Sherpa.OfflineTtsConfig) => {
        calls.tts = cfg;
        return Promise.resolve({
          sampleRate: 44_100,
          numSpeakers: 10,
          generateAsync: (req: Sherpa.TtsRequest) => {
            calls.requests.push(req);
            return Promise.resolve({
              samples: new Float32Array([0.1, 0.2, 0.3]),
              sampleRate: 44_100,
            });
          },
        });
      },
    },
  } as unknown as SherpaTtsModule;
  return { module, calls };
}

describe('adaptateur sherpa-onnx de la synthèse', () => {
  it('charge Supertonic 3 avec les fichiers du catalogue, sur le CPU', async () => {
    const { module, calls } = fakeModule();
    const synth = await createSherpaSynthesizer(config, {
      loadModule: () => module,
      fileExists: () => true,
    });
    expect(synth.sampleRate).toBe(44_100);
    expect(calls.tts).toEqual({
      model: {
        supertonic: {
          durationPredictor: '/models/st/duration_predictor.int8.onnx',
          textEncoder: '/models/st/text_encoder.int8.onnx',
          vectorEstimator: '/models/st/vector_estimator.int8.onnx',
          vocoder: '/models/st/vocoder.int8.onnx',
          ttsJson: '/models/st/tts.json',
          unicodeIndexer: '/models/st/unicode_indexer.bin',
          voiceStyle: '/models/st/voice.bin',
        },
        numThreads: 2,
        provider: 'cpu',
        debug: false,
      },
      maxNumSentences: 1,
    });
  });

  it('voix M4 (style 8), 8 étapes, français, vitesse demandée', async () => {
    const { module, calls } = fakeModule();
    const synth = await createSherpaSynthesizer(config, {
      loadModule: () => module,
      fileExists: () => true,
    });
    const pcm = await synth.synthesize('Bonjour Gilles,', { speed: 1.2 });
    expect(Array.from(pcm)).toEqual([0.1, 0.2, 0.3].map((v) => Math.fround(v)));
    expect(calls.requests[0]?.text).toBe('Bonjour Gilles,');
    expect(calls.gens[0]).toEqual({
      sid: 8,
      speed: 1.2,
      numSteps: SUPERTONIC_NUM_STEPS,
      extra: { lang: 'fr' },
    });
  });

  it('repli à 5 étapes par la configuration de chargement', async () => {
    const { module, calls } = fakeModule();
    const synth = await createSherpaSynthesizer(
      { ...config, numSteps: 5 },
      { loadModule: () => module, fileExists: () => true },
    );
    await synth.synthesize('Bonjour.', { speed: 1 });
    expect(calls.gens[0]?.numSteps).toBe(5);
  });

  it('refuse de parler une fois libéré', async () => {
    const { module } = fakeModule();
    const synth = await createSherpaSynthesizer(config, {
      loadModule: () => module,
      fileExists: () => true,
    });
    synth.dispose();
    await expect(synth.synthesize('Bonjour.', { speed: 1 })).rejects.toMatchObject({
      code: 'voice/engine_failed',
    });
  });

  it('voix inconnue : voice/model_invalid ; fichiers manquants : voice/model_missing', () => {
    expect(() => resolveTtsModel({ ...config, voice: 'piper-tom' })).toThrow(AtelierError);
    try {
      resolveTtsModel(config, { fileExists: (f) => !f.endsWith('voice.bin') });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'voice/model_missing',
        details: { missing: ['voice.bin'] },
      });
    }
  });

  it('chaque fichier attendu par l’adaptateur est dans le catalogue', () => {
    if (SUPERTONIC_3_INT8.source.kind !== 'download') throw new Error('download attendu');
    const files = SUPERTONIC_3_INT8.source.files.map((f) => f.path);
    for (const voice of TTS_VOICES) {
      const layout = SHERPA_TTS_MODELS[voice.modelId];
      expect(layout).toBeDefined();
      for (const file of Object.values(layout ?? {})) expect(files).toContain(file);
    }
  });
});
