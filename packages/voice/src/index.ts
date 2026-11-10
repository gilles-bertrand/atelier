/**
 * `@atelier/voice` : voix locale (ADR-004).
 *
 * L1 : catalogue épinglé des modèles et `VoiceModelManager` (installation
 * atomique, reprise, contrôle SHA-256, miroir, import hors ligne).
 * L2 : interface de moteur, adaptateur sherpa-onnx, pipeline de dictée,
 * protocole main ↔ worker et superviseur du worker.
 * L7 : synthèse vocale (Supertonic 3, voix M4), filtre « prononçable » en
 * français, découpage en phrases au fil du flux et `AgentSpeech`, qui produit
 * les `VoiceAudioOut`.
 */
export * from './catalog.js';
export * from './archive.js';
export * from './manager.js';
export type {
  RecognitionResult,
  SpeechAudioSegment,
  SpeechEngine,
  SpeechSegmenter,
  SpeechSynthesizer,
  SynthesisOptions,
} from './engine.js';
export {
  NBSP,
  NNBSP,
  applyFrenchTypography,
  assembleSegments,
  detectTextLanguage,
  type TextLanguage,
} from './typography.js';
export {
  AudioHistory,
  DictationSession,
  FINAL_BLOCK_BUDGET_MS,
  FINAL_BLOCK_MAX_MS,
  type DictationCallbacks,
  type DictationOptions,
} from './dictation.js';
export {
  engineLoadConfigSchema,
  mainToWorkerSchema,
  parseMainToWorker,
  parseWorkerToMain,
  workerToMainSchema,
  type EngineLoadConfig,
  type EngineLoadConfigInput,
  type MainToWorkerMessage,
  type ParseResult,
  type ParsedMainToWorkerMessage,
  type WorkerToMainMessage,
  MAX_SPEAK_CHARS,
  ttsLoadConfigSchema,
  type TtsLoadConfig,
  type TtsLoadConfigInput,
} from './protocol.js';
export { runVoiceWorker, type VoiceWorkerOptions, type WorkerPort } from './worker.js';
export {
  VoiceWorkerSupervisor,
  type SupervisorEvents,
  type SupervisorOptions,
  type WorkerHandle,
} from './supervisor.js';
export {
  SHERPA_STT_MODELS,
  SILERO_VAD_SETTINGS,
  createSherpaEngine,
  resolveSttModel,
  type SherpaEngineDeps,
  type SherpaModule,
} from './sherpa.js';
export {
  SHERPA_TTS_MODELS,
  createSherpaSynthesizer,
  resolveTtsModel,
  type SherpaTtsDeps,
  type SherpaTtsModule,
} from './sherpa-tts.js';
export {
  amountToFrench,
  endWithPunctuation,
  numberToFrench,
  speakableFrench,
  speakableLine,
} from './speakable.js';
export { dateToFrench, integerToFrench, ordinalToFrench, timeToFrench } from './french-numbers.js';
export {
  FIRST_CLAUSE_MIN_CHARS,
  MAX_CHUNK_CHARS,
  SpeechChunker,
  splitSpeech,
  type SpeechChunkerOptions,
} from './sentences.js';
export {
  AgentSpeech,
  CLAUSE_GAP_MS,
  SENTENCE_GAP_MS,
  clampTtsRate,
  type AgentSpeechOptions,
  type SpeechSynthesisPort,
  type SynthesizedSpeech,
} from './speech.js';
