/**
 * Pipeline de dictée (ADR-004 D6) : trames du micro → segments de parole →
 * texte, une session à la fois.
 *
 * - Chaque segment fermé par une pause est transcrit, dans l'ordre, et émis
 *   aussitôt (`onSegment`) avec la typographie française s'il est en français.
 * - `stop()` transcrit le dernier segment et rend le texte assemblé.
 * - `cancel()` abandonne tout : rien n'est rendu, les transcriptions en cours
 *   sont ignorées.
 * - Au bout de `maxDurationMs` (5 min), la dictée s'arrête d'elle-même
 *   (`onAutoStop`).
 *
 * Confidentialité (D9) : rien n'est écrit sur le disque ; chaque tampon est mis
 * à zéro et relâché après sa transcription, l'historique à la fin de la
 * session ; aucun texte ne part dans les journaux.
 */
import {
  AtelierError,
  MAX_DICTATION_MS,
  VOICE_PRE_ROLL_MS,
  VOICE_SAMPLE_RATE,
  VOICE_SILENT_INPUT_MS,
  type TranscriptSegment,
  type VoiceInputWarning,
  type VoiceSessionState,
} from '@atelier/shared';
import type { SpeechAudioSegment, SpeechEngine, SpeechSegmenter } from './engine.js';
import {
  applyFrenchTypography,
  assembleSegments,
  detectTextLanguage,
  type TextLanguage,
} from './typography.js';

export interface DictationOptions {
  voiceSessionId: string;
  engine: SpeechEngine;
  /** `MAX_DICTATION_MS` par défaut. */
  maxDurationMs?: number;
  /** Audio gardé avant chaque segment, `VOICE_PRE_ROLL_MS` par défaut. */
  preRollMs?: number;
  /** Trames nulles avant l'alerte `silent_input`, `VOICE_SILENT_INPUT_MS` par défaut. */
  silentInputMs?: number;
  /**
   * Audio récent gardé pour le pré-roll, en millisecondes (30 s par défaut) :
   * doit couvrir le plus long segment du détecteur de parole (20 s).
   */
  historyMs?: number;
}

export interface DictationCallbacks {
  /** Segment transcrit, non vide, typographie appliquée. */
  onSegment?: (segment: TranscriptSegment) => void;
  /** Changement d'état de la session, avec une alerte éventuelle sur l'entrée. */
  onState?: (state: VoiceSessionState, warning?: VoiceInputWarning) => void;
  /** Arrêt automatique à la durée maximale : texte final de la dictée. */
  onAutoStop?: (text: string) => void;
  /** Échec du moteur pendant la session (la session est terminée). */
  onError?: (error: AtelierError) => void;
}

/** Fin de session : texte assemblé, ou échec du moteur. */
type Outcome = { ok: true; text: string } | { ok: false; error: AtelierError };

const msToSamples = (ms: number): number => Math.round((ms * VOICE_SAMPLE_RATE) / 1000);
const samplesToMs = (n: number): number => Math.round((n * 1000) / VOICE_SAMPLE_RATE);

/**
 * Audio récent, dans un tampon circulaire de taille fixe : sert seulement à
 * reprendre les 300 ms qui précèdent un segment (début de mot coupé, S1).
 */
export class AudioHistory {
  private readonly buffer: Float32Array;
  /** Échantillons reçus depuis le début de la session. */
  private written = 0;

  constructor(capacitySamples: number) {
    this.buffer = new Float32Array(Math.max(1, capacitySamples));
  }

  get totalSamples(): number {
    return this.written;
  }

  push(pcm: Float32Array): void {
    const cap = this.buffer.length;
    // Seuls les `cap` derniers échantillons comptent.
    const src = pcm.length > cap ? pcm.subarray(pcm.length - cap) : pcm;
    const skipped = pcm.length - src.length;
    let pos = (this.written + skipped) % cap;
    let offset = 0;
    while (offset < src.length) {
      const n = Math.min(src.length - offset, cap - pos);
      this.buffer.set(src.subarray(offset, offset + n), pos);
      offset += n;
      pos = (pos + n) % cap;
    }
    this.written += pcm.length;
  }

  /**
   * Copie des échantillons `[from, to)` (positions absolues), limitée à ce qui
   * est encore dans le tampon.
   */
  slice(from: number, to: number): Float32Array {
    const cap = this.buffer.length;
    const start = Math.max(from, this.written - cap, 0);
    const end = Math.min(to, this.written);
    if (end <= start) return new Float32Array(0);
    const out = new Float32Array(end - start);
    for (let i = start; i < end; i += 1) out[i - start] = this.buffer[i % cap] ?? 0;
    return out;
  }

  /** Efface l'audio gardé. */
  clear(): void {
    this.buffer.fill(0);
    this.written = 0;
  }
}

/** Une session de dictée. Créée par le worker à `start`, jetée après `stop` ou `cancel`. */
export class DictationSession {
  readonly voiceSessionId: string;
  private readonly engine: SpeechEngine;
  private readonly callbacks: DictationCallbacks;
  private readonly maxSamples: number;
  private readonly preRollSamples: number;
  private readonly silentSamples: number;

  private segmenter: SpeechSegmenter | undefined;
  private readonly history: AudioHistory;
  /** Textes des segments, dans l'ordre, typographie appliquée. */
  private texts: string[] = [];
  private nextIndex = 0;
  private language: TextLanguage = 'unknown';
  /** Transcriptions en file : une à la fois, dans l'ordre des segments. */
  private queue: Promise<void> = Promise.resolve();
  private state: VoiceSessionState = 'starting';
  private zeroRun = 0;
  private warning: VoiceInputWarning | undefined;
  private failure: AtelierError | undefined;
  private cancelled = false;
  private ending: Promise<Outcome> | undefined;

  constructor(options: DictationOptions, callbacks: DictationCallbacks = {}) {
    this.voiceSessionId = options.voiceSessionId;
    this.engine = options.engine;
    this.callbacks = callbacks;
    this.maxSamples = msToSamples(options.maxDurationMs ?? MAX_DICTATION_MS);
    this.preRollSamples = msToSamples(options.preRollMs ?? VOICE_PRE_ROLL_MS);
    this.silentSamples = msToSamples(options.silentInputMs ?? VOICE_SILENT_INPUT_MS);
    this.history = new AudioHistory(msToSamples(options.historyMs ?? 30_000));
    this.segmenter = this.engine.createSegmenter();
  }

  /** État courant de la session. */
  get currentState(): VoiceSessionState {
    return this.state;
  }

  /** Vrai tant que la session accepte des trames. */
  get active(): boolean {
    return this.ending === undefined && !this.cancelled;
  }

  /**
   * Ajoute une trame du micro. Ignorée après `stop`, `cancel`, la durée
   * maximale ou un échec du moteur.
   */
  accept(pcm: Float32Array): void {
    if (!this.active || this.segmenter === undefined) return;
    if (this.state === 'starting') this.setState('listening');

    const remaining = this.maxSamples - this.history.totalSamples;
    const frame = pcm.length > remaining ? pcm.subarray(0, Math.max(remaining, 0)) : pcm;
    if (frame.length > 0) {
      this.watchSilence(frame);
      this.history.push(frame);
      this.enqueue(this.segmenter.accept(frame));
    }
    if (this.history.totalSamples >= this.maxSamples) {
      void this.end('max_duration');
    }
  }

  /** Termine la dictée : transcrit le dernier segment et rend le texte assemblé. */
  async stop(): Promise<string> {
    const outcome = await this.end('stopped');
    if (!outcome.ok) throw outcome.error;
    return outcome.text;
  }

  /** Abandonne la dictée : rien n'est rendu, les transcriptions en cours sont ignorées. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.release();
    this.setState('idle');
  }

  private end(reason: 'stopped' | 'max_duration'): Promise<Outcome> {
    if (this.cancelled) {
      return Promise.resolve({
        ok: false,
        error: new AtelierError('voice/engine_failed', 'La dictée a été annulée.'),
      });
    }
    this.ending ??= this.finish(reason);
    return this.ending;
  }

  private async finish(reason: 'stopped' | 'max_duration'): Promise<Outcome> {
    this.setState('transcribing');
    if (this.segmenter !== undefined && this.failure === undefined) {
      this.enqueue(this.segmenter.flush());
    }
    await this.queue;
    const text = assembleSegments(this.texts);
    const failure = this.failure;
    this.release();
    if (this.cancelled) {
      return {
        ok: false,
        error: new AtelierError('voice/engine_failed', 'La dictée a été annulée.'),
      };
    }
    this.setState('idle');
    if (failure !== undefined) return { ok: false, error: failure };
    if (reason === 'max_duration') this.callbacks.onAutoStop?.(text);
    return { ok: true, text };
  }

  private enqueue(segments: SpeechAudioSegment[]): void {
    for (const segment of segments) {
      const start = Math.max(0, segment.startSample - this.preRollSamples);
      const preRoll = this.history.slice(start, segment.startSample);
      const audio = new Float32Array(preRoll.length + segment.samples.length);
      audio.set(preRoll, 0);
      audio.set(segment.samples, preRoll.length);
      // L'audio du segment n'est plus utile qu'à travers `audio`.
      segment.samples.fill(0);
      const startMs = samplesToMs(segment.startSample - preRoll.length);
      const endMs = samplesToMs(segment.startSample + segment.samples.length);
      this.queue = this.queue.then(() => this.transcribe(audio, startMs, endMs));
    }
  }

  private async transcribe(audio: Float32Array, startMs: number, endMs: number): Promise<void> {
    try {
      if (this.cancelled || this.failure !== undefined) return;
      const result = await this.engine.transcribe(audio);
      // `cancel()` a pu passer pendant l'attente.
      if (this.isCancelled()) return;
      const raw = result.text.trim();
      if (raw === '') return;
      const lang = detectTextLanguage(raw, result.lang);
      if (lang !== 'unknown') this.language = lang;
      const text =
        (lang === 'unknown' ? this.language : lang) === 'fr' ? applyFrenchTypography(raw) : raw;
      this.texts.push(text);
      const segment: TranscriptSegment = {
        voiceSessionId: this.voiceSessionId,
        index: this.nextIndex,
        text,
        final: true,
        startMs,
        endMs,
      };
      this.nextIndex += 1;
      this.callbacks.onSegment?.(segment);
    } catch (cause) {
      if (this.cancelled || this.failure !== undefined) return;
      // Le message d'origine n'est pas recopié : il ne contient pas de texte dicté,
      // mais rien ne le garantit pour un moteur futur.
      this.failure = new AtelierError(
        'voice/engine_failed',
        'Le moteur de reconnaissance a échoué pendant la dictée.',
        { retryable: true, cause },
      );
      this.callbacks.onError?.(this.failure);
    } finally {
      audio.fill(0);
    }
  }

  /** Alerte `silent_input` après `silentInputMs` de trames entièrement nulles (S1). */
  private watchSilence(frame: Float32Array): void {
    if (frame.every((v) => v === 0)) {
      this.zeroRun += frame.length;
      if (this.zeroRun >= this.silentSamples && this.warning === undefined) {
        this.warning = 'silent_input';
        this.callbacks.onState?.(this.state, this.warning);
      }
    } else {
      this.zeroRun = 0;
      if (this.warning !== undefined) {
        this.warning = undefined;
        this.callbacks.onState?.(this.state);
      }
    }
  }

  private setState(state: VoiceSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState?.(state, state === 'listening' ? this.warning : undefined);
  }

  /** Lecture non rétrécie par TypeScript : l'état change pendant un `await`. */
  private isCancelled(): boolean {
    return this.cancelled;
  }

  /** Libère le découpeur, l'historique et les textes. */
  private release(): void {
    this.segmenter?.dispose();
    this.segmenter = undefined;
    this.history.clear();
    this.texts = [];
  }
}
