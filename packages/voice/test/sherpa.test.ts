import { describe, expect, it } from 'vitest';
import { AtelierError } from '@atelier/shared';
import type * as Sherpa from 'sherpa-onnx-node';
import { engineLoadConfigSchema } from '../src/protocol.js';
import { createSherpaEngine, resolveSttModel, type SherpaModule } from '../src/sherpa.js';

const config = engineLoadConfigSchema.parse({
  vadModel: '/models/silero_vad.onnx',
  stt: { modelId: 'parakeet-tdt-0.6b-v3-int8', dir: '/models/parakeet' },
});

/** Faux module natif : enregistre les configurations reçues. */
function fakeModule(result: Sherpa.OfflineRecognizerResult = { text: ' Bonjour. ', lang: '' }) {
  const calls: { recognizer?: Sherpa.OfflineRecognizerConfig; vads: Sherpa.VadConfig[] } = {
    vads: [],
  };
  class Vad {
    private pending: Sherpa.SpeechSegment[] = [];
    cleared = false;
    constructor(cfg: Sherpa.VadConfig) {
      calls.vads.push(cfg);
    }
    acceptWaveform(samples: Float32Array): void {
      this.pending.push({ start: 4800, samples });
    }
    isEmpty(): boolean {
      return this.pending.length === 0;
    }
    isDetected(): boolean {
      return false;
    }
    front(): Sherpa.SpeechSegment {
      const s = this.pending[0];
      if (!s) throw new Error('vide');
      return s;
    }
    pop(): void {
      this.pending.shift();
    }
    clear(): void {
      this.cleared = true;
    }
    reset(): void {}
    flush(): void {}
  }
  const module = {
    Vad,
    OfflineRecognizer: {
      createAsync: (cfg: Sherpa.OfflineRecognizerConfig) => {
        calls.recognizer = cfg;
        return Promise.resolve({
          createStream: () => ({ acceptWaveform: () => undefined }),
          decodeAsync: () => Promise.resolve(result),
        });
      },
    },
  } as unknown as SherpaModule;
  return { module, calls };
}

describe('resolveSttModel', () => {
  it('rend les fichiers de Parakeet, sur le CPU et 2 threads par défaut', () => {
    expect(resolveSttModel(config, () => true)).toEqual({
      transducer: {
        encoder: '/models/parakeet/encoder.int8.onnx',
        decoder: '/models/parakeet/decoder.int8.onnx',
        joiner: '/models/parakeet/joiner.int8.onnx',
      },
      tokens: '/models/parakeet/tokens.txt',
      modelType: 'nemo_transducer',
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    });
  });

  it('signale un modèle incomplet (voice/model_missing) sans chemin complet', () => {
    const error = (() => {
      try {
        resolveSttModel(config, (p) => !p.endsWith('joiner.int8.onnx'));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(AtelierError);
    expect((error as AtelierError).code).toBe('voice/model_missing');
    expect((error as AtelierError).details).toEqual({ missing: ['joiner.int8.onnx'] });
  });

  it('refuse un modèle inconnu du moteur (voice/model_invalid)', () => {
    const other = { ...config, stt: { modelId: 'whisper-tiny', dir: '/models/w' } };
    expect(() => resolveSttModel(other, () => true)).toThrow(
      expect.objectContaining({ code: 'voice/model_invalid' }),
    );
  });
});

describe('createSherpaEngine', () => {
  it('configure Silero et Parakeet, découpe et transcrit', async () => {
    const { module, calls } = fakeModule();
    const engine = await createSherpaEngine(config, {
      loadModule: () => module,
      fileExists: () => true,
    });
    expect(calls.recognizer?.modelConfig.provider).toBe('cpu');
    expect(calls.vads[0]?.sileroVad).toMatchObject({
      model: '/models/silero_vad.onnx',
      threshold: 0.5,
      minSilenceDuration: 0.6,
      maxSpeechDuration: 20,
    });
    const segmenter = engine.createSegmenter();
    const input = new Float32Array([0.1, 0.2]);
    const [segment] = segmenter.accept(input);
    expect(segment?.startSample).toBe(4800);
    // Copie indépendante du tampon natif.
    expect(segment?.samples).not.toBe(input);
    expect(Array.from(segment?.samples ?? [])).toEqual(Array.from(input));
    segmenter.dispose();
    expect(segmenter.accept(input)).toEqual([]);

    expect(await engine.transcribe(new Float32Array(16))).toEqual({ text: 'Bonjour.' });
    engine.dispose();
    await expect(engine.transcribe(new Float32Array(16))).rejects.toMatchObject({
      code: 'voice/engine_failed',
    });
  });

  it('transmet la langue quand le moteur la donne', async () => {
    const { module } = fakeModule({ text: 'Hallo.', lang: '<|nl|>' });
    const engine = await createSherpaEngine(config, {
      loadModule: () => module,
      fileExists: () => true,
    });
    expect(await engine.transcribe(new Float32Array(16))).toEqual({
      text: 'Hallo.',
      lang: '<|nl|>',
    });
  });

  it('ne charge pas le module natif si le modèle manque', async () => {
    let loaded = false;
    await expect(
      createSherpaEngine(config, {
        loadModule: () => {
          loaded = true;
          return fakeModule().module;
        },
        fileExists: () => false,
      }),
    ).rejects.toMatchObject({ code: 'voice/model_missing' });
    expect(loaded).toBe(false);
  });
});
