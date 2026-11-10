/**
 * Moteur simulé pour les tests : une trame dont le premier échantillon dépasse
 * 0,1 est de la parole ; une trame plus faible après de la parole ferme le
 * segment. La transcription rend les textes du script, dans l'ordre.
 */
import { VOICE_FRAME_SAMPLES } from '@atelier/shared';
import type {
  RecognitionResult,
  SpeechAudioSegment,
  SpeechEngine,
  SpeechSegmenter,
  SpeechSynthesizer,
  SynthesisOptions,
} from '../src/engine.js';

export function speechFrame(value = 0.5, length = VOICE_FRAME_SAMPLES): Float32Array {
  return new Float32Array(length).fill(value);
}

export function silenceFrame(value = 0.01, length = VOICE_FRAME_SAMPLES): Float32Array {
  return new Float32Array(length).fill(value);
}

export function zeroFrame(length = VOICE_FRAME_SAMPLES): Float32Array {
  return new Float32Array(length);
}

class FakeSegmenter implements SpeechSegmenter {
  private position = 0;
  private start = -1;
  private chunks: Float32Array[] = [];
  disposed = false;

  accept(pcm: Float32Array): SpeechAudioSegment[] {
    const out: SpeechAudioSegment[] = [];
    if ((pcm[0] ?? 0) > 0.1) {
      if (this.start < 0) this.start = this.position;
      this.chunks.push(pcm.slice());
    } else if (this.start >= 0) {
      out.push(this.close());
    }
    this.position += pcm.length;
    return out;
  }

  flush(): SpeechAudioSegment[] {
    return this.start >= 0 ? [this.close()] : [];
  }

  speaking(): boolean {
    return this.start >= 0;
  }

  dispose(): void {
    this.disposed = true;
  }

  private close(): SpeechAudioSegment {
    const n = this.chunks.reduce((a, c) => a + c.length, 0);
    const samples = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) {
      samples.set(c, o);
      o += c.length;
    }
    const segment = { startSample: this.start, samples };
    this.start = -1;
    this.chunks = [];
    return segment;
  }
}

export interface FakeEngineOptions {
  /** Textes rendus par les transcriptions successives. */
  script?: (string | RecognitionResult)[];
  /** Attente avant chaque transcription (promesse contrôlée par le test). */
  gate?: () => Promise<void>;
  /** Échoue à la transcription n (à partir de 0). */
  failAt?: number;
}

export class FakeEngine implements SpeechEngine {
  readonly segmenters: FakeSegmenter[] = [];
  /** Audio reçu par chaque transcription (copie, avant remise à zéro). */
  readonly received: Float32Array[] = [];
  /** Tampons passés à `transcribe`, pour vérifier leur remise à zéro. */
  readonly buffers: Float32Array[] = [];
  disposed = false;
  private calls = 0;

  constructor(private readonly options: FakeEngineOptions = {}) {}

  createSegmenter(): SpeechSegmenter {
    const s = new FakeSegmenter();
    this.segmenters.push(s);
    return s;
  }

  async transcribe(samples: Float32Array): Promise<RecognitionResult> {
    const n = this.calls;
    this.calls += 1;
    this.received.push(samples.slice());
    this.buffers.push(samples);
    if (this.options.gate) await this.options.gate();
    if (this.options.failAt === n) throw new Error('échec natif simulé');
    const entry = this.options.script?.[n] ?? '';
    return typeof entry === 'string' ? { text: entry } : entry;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Promesse résolue à la main. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Laisse passer les microtâches en attente. */
export async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

export interface FakeSynthesizerOptions {
  sampleRate?: number;
  /** Attente avant chaque synthèse (promesse contrôlée par le test). */
  gate?: () => Promise<void>;
  /** Échoue sur ce texte, avec un message qui le cite (il ne doit jamais ressortir). */
  failOn?: string;
}

/** Synthèse simulée : 10 échantillons par caractère, valeur = longueur du texte. */
export class FakeSynthesizer implements SpeechSynthesizer {
  readonly sampleRate: number;
  readonly calls: { text: string; options: SynthesisOptions }[] = [];
  disposed = false;

  constructor(private readonly options: FakeSynthesizerOptions = {}) {
    this.sampleRate = options.sampleRate ?? 44_100;
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<Float32Array> {
    this.calls.push({ text, options });
    if (this.options.gate) await this.options.gate();
    if (this.options.failOn === text) throw new Error(`échec natif sur « ${text} »`);
    return new Float32Array(text.length * 10).fill(text.length);
  }

  dispose(): void {
    this.disposed = true;
  }
}
