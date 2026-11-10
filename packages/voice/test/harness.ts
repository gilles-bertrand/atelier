/** Worker en mémoire : `runVoiceWorker` derrière un faux `WorkerHandle`. */
import type { SpeechEngine, SpeechSynthesizer } from '../src/engine.js';
import type { EngineLoadConfig, TtsLoadConfig, WorkerToMainMessage } from '../src/protocol.js';
import type { WorkerHandle } from '../src/supervisor.js';
import { runVoiceWorker } from '../src/worker.js';

export interface FakeWorker extends WorkerHandle {
  /** Messages envoyés par le worker. */
  readonly sent: WorkerToMainMessage[];
  readonly killed: boolean;
  readonly exited: boolean;
  /** Simule un crash natif (sortie non demandée). */
  crash(): void;
  /** Injecte un message brut, comme s'il venait du worker. */
  emit(data: unknown): void;
}

export function createFakeWorker(
  createEngine: (config: EngineLoadConfig) => Promise<SpeechEngine>,
  createSynthesizer?: (config: TtsLoadConfig) => Promise<SpeechSynthesizer>,
): FakeWorker {
  const toMain: ((data: unknown) => void)[] = [];
  const toWorker: ((data: unknown) => void)[] = [];
  const exitListeners: ((code: number) => void)[] = [];
  const sent: WorkerToMainMessage[] = [];
  let killed = false;
  let exited = false;

  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    // Comme un process : la sortie est signalée après les messages en vol.
    setTimeout(() => {
      for (const l of exitListeners) l(code);
    }, 0);
  };

  runVoiceWorker({
    port: {
      postMessage: (message) => {
        if (exited) return;
        sent.push(message);
        // Clonage asynchrone, comme `postMessage`.
        setTimeout(() => {
          for (const l of toMain) l(message);
        }, 0);
      },
      onMessage: (listener) => toWorker.push(listener),
    },
    createEngine,
    ...(createSynthesizer !== undefined ? { createSynthesizer } : {}),
    exit: () => {
      exit(0);
    },
  });

  return {
    sent,
    get killed() {
      return killed;
    },
    get exited() {
      return exited;
    },
    postMessage: (message) => {
      if (exited) throw new Error('worker sorti');
      setTimeout(() => {
        if (!exited) for (const l of toWorker) l(message);
      }, 0);
    },
    onMessage: (listener) => toMain.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    kill: () => {
      killed = true;
      exit(9);
    },
    crash: () => {
      exit(134);
    },
    emit: (data) => {
      for (const l of toMain) l(data);
    },
  };
}
