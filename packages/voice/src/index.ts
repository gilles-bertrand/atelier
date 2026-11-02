/**
 * `@atelier/voice` : voix locale (ADR-004).
 *
 * L1 : catalogue épinglé des modèles et `VoiceModelManager` (installation
 * atomique, reprise, contrôle SHA-256, miroir, import hors ligne).
 * L2 : interface de moteur, adaptateur sherpa-onnx, pipeline de dictée,
 * protocole main ↔ worker et superviseur du worker.
 */
export * from './catalog.js';
export * from './archive.js';
export * from './manager.js';
export type {
  RecognitionResult,
  SpeechAudioSegment,
  SpeechEngine,
  SpeechSegmenter,
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
