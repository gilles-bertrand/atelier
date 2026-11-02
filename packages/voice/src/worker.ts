/**
 * Côté worker du protocole (ADR-004 D2) : reçoit les messages du main, les
 * valide, pilote le moteur et la session de dictée en cours.
 *
 * Le point d'entrée du `utilityProcess` (L3, `apps/desktop`) se réduit à :
 *
 * ```ts
 * runVoiceWorker({ port: parentPortAdapter, createEngine: createSherpaEngine, exit: () => process.exit(0) });
 * ```
 *
 * Le worker ne fait aucun appel réseau et n'écrit aucun fichier (§7, D9).
 */
import { AtelierError, type SerializedAtelierError } from '@atelier/shared';
import { DictationSession } from './dictation.js';
import type { SpeechEngine } from './engine.js';
import {
  parseMainToWorker,
  type EngineLoadConfig,
  type ParsedMainToWorkerMessage,
  type WorkerToMainMessage,
} from './protocol.js';

/** Port de messages du worker (`process.parentPort` d'Electron, adapté). */
export interface WorkerPort {
  postMessage(message: WorkerToMainMessage): void;
  onMessage(listener: (data: unknown) => void): void;
}

export interface VoiceWorkerOptions {
  port: WorkerPort;
  /** Charge les modèles ; l'adaptateur sherpa-onnx en production, un faux moteur en test. */
  createEngine: (config: EngineLoadConfig) => Promise<SpeechEngine>;
  /** Fin du process, après `shutdown`. */
  exit: () => void;
  /** Horloge, pour mesurer le chargement. */
  now?: () => number;
}

/** Erreur sérialisable ; le message d'une erreur inconnue n'est jamais recopié. */
function toSerialized(error: unknown, fallback: AtelierError): SerializedAtelierError {
  return error instanceof AtelierError ? error.toJSON() : fallback.toJSON();
}

/** Démarre la boucle de messages du worker. Rend une fonction d'arrêt (tests). */
export function runVoiceWorker(options: VoiceWorkerOptions): { dispose: () => void } {
  const { port, createEngine, exit } = options;
  const now = options.now ?? (() => performance.now());

  let engine: SpeechEngine | undefined;
  let engineKey = '';
  let session: DictationSession | undefined;
  /** Messages traités un par un, dans l'ordre d'arrivée. */
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  const post = (message: WorkerToMainMessage): void => {
    if (!disposed) port.postMessage(message);
  };

  const sessionError = (voiceSessionId: string, error: AtelierError): void => {
    post({ type: 'error', voiceSessionId, error: error.toJSON() });
  };

  async function load(config: EngineLoadConfig): Promise<void> {
    const key = JSON.stringify(config);
    if (engine !== undefined && key === engineKey) {
      post({ type: 'loaded', loadMs: 0 });
      return;
    }
    if (session !== undefined) {
      post({
        type: 'error',
        error: new AtelierError('voice/busy', 'Une dictée est en cours.').toJSON(),
      });
      return;
    }
    engine?.dispose();
    engine = undefined;
    const t0 = now();
    try {
      engine = await createEngine(config);
      engineKey = key;
      post({ type: 'loaded', loadMs: Math.round(now() - t0) });
    } catch (error) {
      post({
        type: 'error',
        error: toSerialized(
          error,
          new AtelierError(
            'voice/engine_failed',
            'Le moteur de reconnaissance n’a pas pu charger le modèle.',
            { retryable: true },
          ),
        ),
      });
    }
  }

  function start(voiceSessionId: string, maxDurationMs: number | undefined): void {
    if (session !== undefined) {
      sessionError(voiceSessionId, new AtelierError('voice/busy', 'Une dictée est déjà en cours.'));
      return;
    }
    if (engine === undefined) {
      sessionError(
        voiceSessionId,
        new AtelierError('voice/engine_failed', 'Le moteur de reconnaissance n’est pas chargé.', {
          retryable: true,
        }),
      );
      return;
    }
    const current: DictationSession = new DictationSession(
      { voiceSessionId, engine, ...(maxDurationMs !== undefined ? { maxDurationMs } : {}) },
      {
        onSegment: (segment) => {
          post({ type: 'transcript', segment });
        },
        onState: (state, warning) => {
          post({ type: 'state', voiceSessionId, state, ...(warning ? { warning } : {}) });
        },
        onAutoStop: (text) => {
          if (session === current) session = undefined;
          post({ type: 'final', voiceSessionId, text, reason: 'max_duration' });
        },
        onError: (error) => {
          sessionError(voiceSessionId, error);
        },
      },
    );
    session = current;
    post({ type: 'state', voiceSessionId, state: 'starting' });
  }

  async function stop(voiceSessionId: string): Promise<void> {
    const current = session;
    if (current?.voiceSessionId !== voiceSessionId) return;
    try {
      const text = await current.stop();
      if (session === current) session = undefined;
      post({ type: 'final', voiceSessionId, text, reason: 'stopped' });
    } catch (error) {
      if (session === current) session = undefined;
      // `onError` a déjà prévenu le main d'un échec du moteur ; une annulation n'a rien à dire.
      if (!(error instanceof AtelierError)) {
        sessionError(
          voiceSessionId,
          new AtelierError('voice/engine_failed', 'La dictée n’a pas pu être terminée.'),
        );
      }
    }
  }

  function cancel(voiceSessionId: string): void {
    const current = session;
    if (current?.voiceSessionId !== voiceSessionId) return;
    session = undefined;
    current.cancel();
  }

  function shutdown(): void {
    session?.cancel();
    session = undefined;
    engine?.dispose();
    engine = undefined;
    disposed = true;
    exit();
  }

  async function handle(message: ParsedMainToWorkerMessage): Promise<void> {
    switch (message.type) {
      case 'load':
        await load(message.config);
        return;
      case 'start':
        start(message.voiceSessionId, message.maxDurationMs);
        return;
      case 'audio':
        // Hors session : ignorée (le main filtre déjà, D3).
        if (session?.voiceSessionId === message.voiceSessionId) session.accept(message.pcm);
        return;
      case 'stop':
        await stop(message.voiceSessionId);
        return;
      case 'cancel':
        cancel(message.voiceSessionId);
        return;
      case 'shutdown':
        shutdown();
        return;
    }
  }

  port.onMessage((data) => {
    if (disposed) return;
    const parsed = parseMainToWorker(data);
    if (!parsed.ok) {
      post({ type: 'rejected', issue: parsed.issue });
      return;
    }
    const message = parsed.message;
    // L'annulation passe sans attendre : un `stop` en cours de transcription ne
    // doit pas la retarder. Le reste est traité dans l'ordre d'arrivée.
    if (message.type === 'cancel') {
      void handle(message);
      return;
    }
    chain = chain.then(() => handle(message));
  });

  post({ type: 'ready' });

  return {
    dispose: () => {
      session?.cancel();
      engine?.dispose();
      disposed = true;
    },
  };
}
