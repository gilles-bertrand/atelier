/**
 * Interface d'un moteur de reconnaissance (ADR-004 D2), locale au package.
 *
 * Le pipeline de dictée ne connaît que cette interface : un moteur serveur
 * (option D) ou natif (option B) pourra s'y brancher plus tard sans toucher au
 * pipeline, au worker ni à l'UI.
 *
 * Un moteur a deux rôles :
 * - découper le flux du micro en segments de parole (détection de parole) ;
 * - transcrire un segment.
 */

/** Segment de parole découpé par la détection de parole. */
export interface SpeechAudioSegment {
  /** Position du premier échantillon depuis le début du flux (16 kHz). */
  startSample: number;
  /** PCM mono, `VOICE_SAMPLE_RATE` Hz. */
  samples: Float32Array;
}

/** Découpe un flux PCM en segments de parole, à chaque pause. */
export interface SpeechSegmenter {
  /** Ajoute des échantillons ; rend les segments que ces échantillons ferment. */
  accept(pcm: Float32Array): SpeechAudioSegment[];
  /** Fin du flux : rend le segment en cours, s'il y en a un. */
  flush(): SpeechAudioSegment[];
  /** Libère l'état natif. Le découpeur n'est plus utilisable ensuite. */
  dispose(): void;
}

/** Résultat de la transcription d'un segment. */
export interface RecognitionResult {
  text: string;
  /**
   * Langue détectée par le moteur, si elle est fournie (BCP 47 ou `<|fr|>`).
   * Parakeet v3 ne la donne pas : le pipeline la devine alors sur le texte.
   */
  lang?: string;
}

/** Moteur de reconnaissance chargé (modèles en mémoire). */
export interface SpeechEngine {
  /** Nouveau découpeur, un par session de dictée. */
  createSegmenter(): SpeechSegmenter;
  /** Transcrit un segment (PCM mono, `VOICE_SAMPLE_RATE` Hz). */
  transcribe(samples: Float32Array): Promise<RecognitionResult>;
  /** Libère les modèles. */
  dispose(): void;
}
