/**
 * Pipeline de dictée (ADR-004 D6) : trames du micro → segments de parole →
 * texte, une session à la fois.
 *
 * - Chaque segment fermé par une pause est transcrit, dans l'ordre, et émis
 *   aussitôt (`onSegment`) avec la typographie française s'il est en français.
 * - `stop()` rend le texte final. Quand la retranscription d'un bloc tient
 *   dans le délai du texte final (1 s, d'après la vitesse du moteur mesurée
 *   pendant la session) et la parole en 20 s, tous les segments sont
 *   retranscrits d'un bloc : Parakeet retrouve le contexte coupé aux pauses et
 *   ne met plus de point à chaque pause (#42). Sinon, ou si le bloc échoue ou
 *   tarde, les textes des segments sont assemblés, sans le point d'une pause
 *   au milieu d'une phrase.
 * - `cancel()` abandonne tout : rien n'est rendu, les transcriptions en cours
 *   sont ignorées.
 * - Au bout de `maxDurationMs` (5 min), la dictée s'arrête d'elle-même
 *   (`onAutoStop`).
 * - Mode conversation (L9) : avec `endOfTurnSilenceMs`, la session signale la
 *   fin du tour de parole (`onEndOfTurn`) quand ce silence suit un segment
 *   fermé et que plus personne ne parle, et chaque reprise de parole
 *   (`onSpeechStart`). C'est le main qui arrête alors la session (`stop`).
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
  /**
   * Plafond de l'audio de parole (pré-roll compris) retranscrit d'un bloc à
   * l'arrêt, en millisecondes : `FINAL_BLOCK_MAX_MS` par défaut, 0 pour
   * assembler toujours les segments.
   */
  finalBlockMaxMs?: number;
  /**
   * Délai accordé au bloc, en millisecondes : `FINAL_BLOCK_BUDGET_MS` par
   * défaut. Le bloc n'est tenté que si sa durée prévue (vitesse mesurée × 1,5)
   * y tient ; au-delà de ce délai, les segments sont assemblés.
   */
  finalBlockBudgetMs?: number;
  /** Horloge en millisecondes, `performance.now` par défaut (injectable en test). */
  now?: () => number;
  /**
   * Mode conversation (L9) : silence, en millisecondes, qui termine un tour de
   * parole. Compté depuis la fin du dernier segment fermé ; le détecteur ne
   * ferme un segment qu'après son propre silence minimal (600 ms pour
   * Silero), qui borne donc le délai par le bas. Absent : dictée, pas de fin
   * de tour.
   */
  endOfTurnSilenceMs?: number;
}

/**
 * Plafond de la parole retranscrite d'un bloc (#42), quelle que soit la
 * vitesse du moteur : 643 ms pour 20 s d'audio de parole sur M4 Max (Parakeet
 * v3 int8, 2 threads), 1,5 s pour 45 s.
 */
export const FINAL_BLOCK_MAX_MS = 20_000;
/** Délai du texte final par bloc (N3 : texte final en 1 s au plus). */
export const FINAL_BLOCK_BUDGET_MS = 1_000;
/** Marge sur la durée prévue du bloc, d'après la vitesse mesurée des segments. */
const FINAL_BLOCK_MARGIN = 1.5;
/**
 * Audio gardé après chaque segment dans le bloc (la pause qui l'a fermé),
 * complété par du silence s'il n'est pas encore arrivé. Sans lui, Parakeet
 * colle deux segments (« souverain|et maintenance » → « souverainance ») et
 * perd la fin du dernier : WER des phrases de Gilles 23,2 % sans, 18,7 % avec
 * 300 ms (24,5 % segment par segment).
 */
const FINAL_BLOCK_POST_ROLL_MS = 300;

/** Segment sauté pendant l'arrêt, gardé pour le repli si le bloc échoue. */
interface PendingSegment {
  audio: Float32Array;
  startMs: number;
  endMs: number;
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
  /** Mode conversation : fin du tour de parole (silence de `endOfTurnSilenceMs`). */
  onEndOfTurn?: () => void;
  /** Mode conversation : l'utilisateur se met à parler. */
  onSpeechStart?: () => void;
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
  private readonly blockMaxSamples: number;
  private readonly blockBudgetMs: number;
  private readonly postRollSamples: number;
  private readonly now: () => number;
  /** Silence de fin de tour, en échantillons ; `undefined` hors conversation. */
  private readonly endOfTurnSamples: number | undefined;
  /** Fin (position absolue) du dernier segment fermé. */
  private lastSpeechEnd = 0;
  /** Un segment fermé attend sa fin de tour. */
  private turnPending = false;
  /** Le détecteur entendait de la parole à la trame précédente. */
  private wasSpeaking = false;

  private segmenter: SpeechSegmenter | undefined;
  private readonly history: AudioHistory;
  /** Textes des segments, dans l'ordre, typographie appliquée. */
  private texts: string[] = [];
  /**
   * Audio des segments (pré-roll compris), gardé pour la retranscription d'un
   * bloc ; `undefined` dès que la parole dépasse `finalBlockMaxMs`.
   */
  private blockAudio: Float32Array[] | undefined = [];
  private blockSamples = 0;
  /** Fin (position absolue) du dernier segment gardé : le pré-roll suivant ne la recouvre pas. */
  private blockEnd = 0;
  /** Arrêt en cours avec retranscription d'un bloc : les segments en file sont sautés. */
  private finalizingBlock = false;
  /** Segments sautés pendant l'arrêt, transcrits seulement si le bloc échoue. */
  private skipped: PendingSegment[] = [];
  /** Vitesse mesurée du moteur : durée des transcriptions et audio transcrit. */
  private decodeMs = 0;
  private decodedSamples = 0;
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
    this.blockMaxSamples = msToSamples(options.finalBlockMaxMs ?? FINAL_BLOCK_MAX_MS);
    this.blockBudgetMs = options.finalBlockBudgetMs ?? FINAL_BLOCK_BUDGET_MS;
    this.postRollSamples = msToSamples(FINAL_BLOCK_POST_ROLL_MS);
    this.now = options.now ?? (() => performance.now());
    this.endOfTurnSamples =
      options.endOfTurnSilenceMs !== undefined
        ? msToSamples(options.endOfTurnSilenceMs)
        : undefined;
    if (this.blockMaxSamples <= 0) this.blockAudio = undefined;
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
      const closed = this.segmenter.accept(frame);
      this.enqueue(closed);
      this.watchTurn(closed);
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
    // Les segments qui n'ont pas commencé attendent : le bloc les reprendra s'il
    // est retenu. La décision suit le segment en cours, qui mesure le moteur.
    if (this.blockAudio !== undefined && this.blockAudio.length > 0) this.finalizingBlock = true;
    await this.queue;
    const block = this.blockFits() ? this.blockAudio : undefined;
    let text: string | undefined;
    if (block !== undefined && this.failure === undefined && !this.cancelled) {
      text = await this.transcribeBlock(block);
    }
    this.dropBlock();
    if (text === undefined) {
      // Repli : les segments sautés sont transcrits, puis assemblés.
      this.finalizingBlock = false;
      const pending = this.skipped;
      this.skipped = [];
      for (const p of pending) await this.transcribe(p.audio, p.startMs, p.endMs);
      text = assembleSegments(this.texts);
    }
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
      this.keepForBlock(start, segment.startSample + segment.samples.length);
      const startMs = samplesToMs(segment.startSample - preRoll.length);
      const endMs = samplesToMs(segment.startSample + segment.samples.length);
      this.queue = this.queue.then(() => this.transcribe(audio, startMs, endMs));
    }
  }

  /**
   * Garde pour le bloc l'audio `[start, end)` d'un segment (pré-roll compris)
   * et la pause qui le suit (`FINAL_BLOCK_POST_ROLL_MS`), tant que le bloc
   * tient dans son plafond. Positions absolues dans le flux.
   */
  private keepForBlock(start: number, end: number): void {
    if (this.blockAudio === undefined) return;
    // Pause déjà gardée après le segment précédent : pas d'audio en double.
    const from = Math.max(start, this.blockEnd);
    const to = Math.max(from, end + this.postRollSamples);
    this.blockEnd = to;
    this.blockSamples += to - from;
    if (this.blockSamples > this.blockMaxSamples) {
      this.dropBlock();
      return;
    }
    // La fin de la pause n'est peut-être pas encore reçue : silence à la place.
    const part = new Float32Array(to - from);
    const heard = this.history.slice(from, to);
    part.set(heard, 0);
    heard.fill(0);
    this.blockAudio.push(part);
  }

  /**
   * Le bloc est-il utile et tient-il dans son délai ? Un seul segment n'a pas
   * de pause interne : déjà transcrit pendant l'écoute, son texte sert tel
   * quel ; sauté à l'arrêt, il coûte autant en bloc qu'à part. Sinon, la durée
   * prévue (vitesse mesurée sur les segments déjà transcrits, × 1,5) doit tenir
   * dans `finalBlockBudgetMs` ; sans mesure, le bloc n'est pas tenté.
   */
  private blockFits(): boolean {
    const block = this.blockAudio;
    if (block === undefined || block.length === 0) return false;
    if (block.length === 1) return this.skipped.length > 0;
    if (this.decodedSamples === 0) return false;
    const predictedMs =
      (this.blockSamples * this.decodeMs * FINAL_BLOCK_MARGIN) / this.decodedSamples;
    return predictedMs <= this.blockBudgetMs;
  }

  /** Efface et relâche l'audio gardé pour le bloc. */
  private dropBlock(): void {
    for (const part of this.blockAudio ?? []) part.fill(0);
    this.blockAudio = undefined;
  }

  /** Texte d'un résultat du moteur, typographie appliquée ; met à jour la langue. */
  private finishText(rawText: string, engineLang: string | undefined): string {
    const raw = rawText.trim();
    if (raw === '') return '';
    const lang = detectTextLanguage(raw, engineLang);
    if (lang !== 'unknown') this.language = lang;
    return (lang === 'unknown' ? this.language : lang) === 'fr' ? applyFrenchTypography(raw) : raw;
  }

  /**
   * Retranscrit d'un bloc tous les segments de la dictée, mis bout à bout.
   * Rend `undefined` si le moteur échoue ou dépasse `finalBlockBudgetMs` :
   * l'appelant assemble alors les segments, sans erreur.
   *
   * Limite connue : le décodage natif ne s'interrompt pas. Après un
   * dépassement, les segments sautés passent derrière la fin du bloc dans le
   * moteur, et le texte final peut arriver au-delà de N3 (≈ délai + fin du
   * bloc + segments sautés). Cas rare : le bloc n'est tenté que si la vitesse
   * mesurée prévoit qu'il tient, avec une marge de × 1,5.
   */
  private async transcribeBlock(parts: Float32Array[]): Promise<string | undefined> {
    const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      audio.set(part, offset);
      offset += part.length;
    }
    this.dropBlock();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined);
      }, this.blockBudgetMs);
    });
    const decoded = this.engine.transcribe(audio).then(
      (result) => (this.isCancelled() ? '' : this.finishText(result.text, result.lang)),
      () => undefined,
    );
    try {
      return await Promise.race([decoded, late]);
    } finally {
      clearTimeout(timer);
      // Le décodage natif ne s'interrompt pas : l'audio est effacé à sa fin.
      void decoded.finally(() => audio.fill(0));
    }
  }

  private fail(cause: unknown): void {
    if (this.cancelled || this.failure !== undefined) return;
    // Le message d'origine n'est pas recopié : il ne contient pas de texte dicté,
    // mais rien ne le garantit pour un moteur futur.
    this.failure = new AtelierError(
      'voice/engine_failed',
      'Le moteur de reconnaissance a échoué pendant la dictée.',
      { retryable: true, cause },
    );
    this.callbacks.onError?.(this.failure);
  }

  private async transcribe(audio: Float32Array, startMs: number, endMs: number): Promise<void> {
    if (this.finalizingBlock && !this.cancelled && this.failure === undefined) {
      // Repris par le bloc ; transcrit seulement si le bloc échoue.
      this.skipped.push({ audio, startMs, endMs });
      return;
    }
    try {
      if (this.cancelled || this.failure !== undefined) return;
      const started = this.now();
      const result = await this.engine.transcribe(audio);
      this.decodeMs += this.now() - started;
      this.decodedSamples += audio.length;
      // `cancel()` a pu passer pendant l'attente.
      if (this.isCancelled()) return;
      const text = this.finishText(result.text, result.lang);
      if (text === '') return;
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
      this.fail(cause);
    } finally {
      audio.fill(0);
    }
  }

  /**
   * Fin de tour du mode conversation : un segment s'est fermé, personne ne
   * parle et le silence depuis sa fin atteint `endOfTurnSamples`. Signalée une
   * fois par tour ; une reprise de parole relance l'attente.
   */
  private watchTurn(closed: SpeechAudioSegment[]): void {
    if (this.endOfTurnSamples === undefined || this.segmenter === undefined) return;
    const speaking = this.segmenter.speaking?.() ?? false;
    if (speaking && !this.wasSpeaking) this.callbacks.onSpeechStart?.();
    this.wasSpeaking = speaking;
    for (const segment of closed) {
      this.lastSpeechEnd = Math.max(
        this.lastSpeechEnd,
        segment.startSample + segment.samples.length,
      );
      this.turnPending = true;
    }
    if (
      this.turnPending &&
      !speaking &&
      this.history.totalSamples - this.lastSpeechEnd >= this.endOfTurnSamples
    ) {
      this.turnPending = false;
      this.callbacks.onEndOfTurn?.();
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
    this.dropBlock();
    for (const p of this.skipped) p.audio.fill(0);
    this.skipped = [];
  }
}
