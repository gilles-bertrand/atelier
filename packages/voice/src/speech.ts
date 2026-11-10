/**
 * Voix de l'agent (ADR-004 D7, L7) : du texte en flux au PCM à jouer.
 *
 * Pour chaque tour de l'agent :
 *  1. le texte arrive par morceaux (`push`) et passe par le découpeur
 *     ({@link SpeechChunker}) : phrases, première phrase coupée à la virgule,
 *     filtre « prononçable » ;
 *  2. chaque morceau est synthétisé à son tour, un seul à la fois, par un
 *     {@link SpeechSynthesisPort} (le superviseur du worker en production) ;
 *  3. l'audio sort en {@link VoiceAudioOut}, dans l'ordre, avec `seq` croissant
 *     sur toute la session ; le dernier morceau du tour porte `final: true`.
 *
 * L9 branche `onAudio` sur l'événement `voice:audio-out`. Rien n'est écrit sur
 * le disque, et ni le texte ni l'audio n'apparaissent dans les journaux.
 */
import {
  AtelierError,
  VOICE_TTS_RATE_MAX,
  VOICE_TTS_RATE_MIN,
  type VoiceAudioOut,
} from '@atelier/shared';
import { SpeechChunker } from './sentences.js';

/** Audio d'un morceau synthétisé. */
export interface SynthesizedSpeech {
  sampleRate: number;
  pcm: Float32Array;
}

/** Synthèse d'un morceau de texte déjà filtré (le superviseur du worker l'implémente). */
export interface SpeechSynthesisPort {
  synthesize(text: string, speed: number): Promise<SynthesizedSpeech>;
}

/** Silence avant une nouvelle phrase (S2 : 0,25 s entre deux phrases). */
export const SENTENCE_GAP_MS = 250;
/** Silence après la première proposition, coupée à la virgule ou au deux-points. */
export const CLAUSE_GAP_MS = 120;
/** Fréquence annoncée pour un morceau final vide, avant toute synthèse (Supertonic 3). */
const DEFAULT_OUTPUT_SAMPLE_RATE = 44_100;

export interface AgentSpeechOptions {
  voiceSessionId: string;
  synthesizer: SpeechSynthesisPort;
  /** Morceau prêt à jouer (`voice:audio-out`). */
  onAudio: (chunk: VoiceAudioOut) => void;
  /** Échec de la synthèse d'un tour ; le tour se termine (morceau final vide). */
  onError?: (turnId: string, error: AtelierError) => void;
  /** `VoiceSettings.ttsRate` ; 1 par défaut, borné à [0,8 ; 1,3]. */
  rate?: number;
}

interface Turn {
  id: string;
  chunker: SpeechChunker;
  /** Morceaux filtrés en attente de synthèse. */
  queue: string[];
  /** Le texte du tour est complet (`end`). */
  ended: boolean;
  /** Une synthèse est en cours. */
  busy: boolean;
  /** Morceaux déjà émis pour ce tour. */
  emitted: number;
  /** Le dernier morceau émis finissait une proposition (virgule, deux-points). */
  afterClause: boolean;
  /** Le morceau final est parti : le tour est terminé. */
  done: boolean;
}

/** Borne la vitesse aux limites de `VoiceSettings.ttsRate`. */
export function clampTtsRate(rate: number | undefined): number {
  if (rate === undefined || !Number.isFinite(rate)) return 1;
  return Math.min(VOICE_TTS_RATE_MAX, Math.max(VOICE_TTS_RATE_MIN, rate));
}

/** Préfixe `gapMs` de silence à `pcm`. */
function withLeadingSilence(pcm: Float32Array, sampleRate: number, gapMs: number): Float32Array {
  const gap = Math.round((sampleRate * gapMs) / 1000);
  if (gap <= 0) return pcm;
  const out = new Float32Array(gap + pcm.length);
  out.set(pcm, gap);
  return out;
}

/**
 * Voix de l'agent pour une session du mode conversation : un tour à la fois.
 * Commencer un tour interrompt le précédent.
 */
export class AgentSpeech {
  private readonly options: AgentSpeechOptions;
  private rate: number;
  private seq = 0;
  private sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE;
  private turn: Turn | undefined;

  constructor(options: AgentSpeechOptions) {
    this.options = options;
    this.rate = clampTtsRate(options.rate);
  }

  /** Tour en cours de parole (texte ou audio en attente), s'il y en a un. */
  get activeTurnId(): string | undefined {
    return this.turn?.done === false ? this.turn.id : undefined;
  }

  /** Change la vitesse (Réglages › Voix) ; s'applique au morceau suivant. */
  setRate(rate: number): void {
    this.rate = clampTtsRate(rate);
  }

  /** Nouveau tour de l'agent ; un tour encore en cours est interrompu. */
  begin(turnId: string): void {
    this.interrupt();
    this.turn = {
      id: turnId,
      chunker: new SpeechChunker(),
      queue: [],
      ended: false,
      busy: false,
      emitted: 0,
      afterClause: false,
      done: false,
    };
  }

  /** Texte de l'agent, au fil du flux. Ignoré hors du tour en cours. */
  push(turnId: string, delta: string): void {
    const turn = this.current(turnId);
    if (turn === undefined || turn.ended) return;
    turn.queue.push(...turn.chunker.push(delta));
    this.pump(turn);
  }

  /** Fin du texte du tour : le reste est prononcé, puis le morceau final part. */
  end(turnId: string): void {
    const turn = this.current(turnId);
    if (turn === undefined || turn.ended) return;
    turn.ended = true;
    turn.queue.push(...turn.chunker.flush());
    this.pump(turn);
  }

  /**
   * Arrête la voix tout de suite (bouton « Interrompre », Stop, fin du mode) :
   * file vidée, synthèse en cours ignorée, aucun morceau final. Le renderer
   * coupe la lecture de son côté.
   */
  interrupt(): void {
    const turn = this.turn;
    if (turn === undefined) return;
    turn.done = true;
    turn.queue = [];
    this.turn = undefined;
  }

  private current(turnId: string): Turn | undefined {
    const turn = this.turn;
    return turn?.id === turnId && !turn.done ? turn : undefined;
  }

  private pump(turn: Turn): void {
    if (turn.busy || turn.done) return;
    const text = turn.queue.shift();
    if (text === undefined) {
      if (turn.ended) this.finish(turn, new Float32Array(0));
      return;
    }
    turn.busy = true;
    this.options.synthesizer.synthesize(text, this.rate).then(
      (speech) => {
        turn.busy = false;
        if (turn.done) return;
        this.sampleRate = speech.sampleRate;
        const gapMs = turn.emitted === 0 ? 0 : turn.afterClause ? CLAUSE_GAP_MS : SENTENCE_GAP_MS;
        const pcm = withLeadingSilence(speech.pcm, speech.sampleRate, gapMs);
        turn.afterClause = /[,:]$/u.test(text);
        if (turn.ended && turn.queue.length === 0) {
          this.finish(turn, pcm);
          return;
        }
        this.emit(turn, pcm, false);
        this.pump(turn);
      },
      (error: unknown) => {
        turn.busy = false;
        if (turn.done) return;
        // Le message d'origine n'est pas recopié : il pourrait citer le texte.
        const failure =
          error instanceof AtelierError
            ? error
            : new AtelierError('voice/engine_failed', 'La synthèse vocale a échoué.', {
                retryable: true,
              });
        this.options.onError?.(turn.id, failure);
        turn.queue = [];
        this.finish(turn, new Float32Array(0));
      },
    );
  }

  private finish(turn: Turn, pcm: Float32Array): void {
    this.emit(turn, pcm, true);
    turn.done = true;
    if (this.turn === turn) this.turn = undefined;
  }

  private emit(turn: Turn, pcm: Float32Array, final: boolean): void {
    const chunk: VoiceAudioOut = {
      voiceSessionId: this.options.voiceSessionId,
      turnId: turn.id,
      seq: this.seq,
      sampleRate: this.sampleRate,
      pcm,
      final,
    };
    this.seq += 1;
    turn.emitted += 1;
    this.options.onAudio(chunk);
  }
}
