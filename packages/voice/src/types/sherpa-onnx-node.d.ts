/**
 * Déclaration minimale de `sherpa-onnx-node` 2.0.1, limitée à ce qu'utilise
 * `sherpa.ts` et le test réel : le paquet ne publie que du JavaScript annoté en JSDoc
 * (`types.js`), sans fichier `.d.ts`.
 *
 * Même démarche que `jsdom.d.ts` (`packages/web`) : on ne déclare que la
 * surface utilisée, vérifiée contre `non-streaming-asr.js` et `vad.js`.
 */
declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface FeatureConfig {
    sampleRate?: number;
    featureDim?: number;
  }

  export interface OfflineTransducerModelConfig {
    encoder: string;
    decoder: string;
    joiner: string;
  }

  export interface OfflineModelConfig {
    transducer?: OfflineTransducerModelConfig;
    tokens: string;
    /** `nemo_transducer` pour Parakeet. */
    modelType?: string;
    numThreads?: number;
    provider?: 'cpu' | 'coreml';
    debug?: number;
  }

  export interface OfflineRecognizerConfig {
    featConfig?: FeatureConfig;
    modelConfig: OfflineModelConfig;
    /** `greedy_search` (défaut) ou `modified_beam_search` (seul compatible avec les hotwords). */
    decodingMethod?: string;
    maxActivePaths?: number;
  }

  /** Résultat JSON de `OfflineRecognizerResult::AsJsonString()`. */
  export interface OfflineRecognizerResult {
    text: string;
    lang?: string;
    tokens?: string[];
    timestamps?: number[];
  }

  export class OfflineStream {
    acceptWaveform(wave: Waveform): void;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(hotwords?: string): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
  }

  export interface SileroVadModelConfig {
    model: string;
    threshold?: number;
    minSpeechDuration?: number;
    minSilenceDuration?: number;
    maxSpeechDuration?: number;
    windowSize?: number;
  }

  export interface VadConfig {
    sileroVad: SileroVadModelConfig;
    sampleRate: number;
    numThreads?: number;
    provider?: string;
    debug?: number;
  }

  export interface SpeechSegment {
    /** Position du premier échantillon depuis le dernier `reset`. */
    start: number;
    samples: Float32Array;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    /** `false` : copie des échantillons, indépendante du tampon natif. */
    front(enableExternalBuffer?: boolean): SpeechSegment;
    pop(): void;
    clear(): void;
    reset(): void;
    flush(): void;
  }

  /** Rééchantillonneur linéaire (test réel : WAV de Parakeet à 22,05 et 24 kHz). */
  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number);
    resample(samples: Float32Array): Float32Array;
    flush(samples: Float32Array): Float32Array;
  }

  export function readWave(filename: string, enableExternalBuffer?: boolean): Waveform;
}
