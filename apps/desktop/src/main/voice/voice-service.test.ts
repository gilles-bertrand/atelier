import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AtelierError,
  DEFAULT_VOICE_SETTINGS,
  VOICE_FRAME_SAMPLES,
  isAtelierError,
  type AtelierErrorCode,
  type IpcEventChannel,
  type MicAccess,
  type VoiceModelInfo,
  type VoiceSettings,
} from '@atelier/shared';
import {
  PARAKEET_TDT_V3_INT8,
  SILERO_VAD,
  toModelInfo,
  type MainToWorkerMessage,
  type ResolvedVoiceModel,
  type WorkerHandle,
} from '@atelier/voice';
import { VoiceService, type VoiceCaller, type VoiceServiceOptions } from './voice-service.js';

const MAIN: VoiceCaller = { senderId: 1, fromMainFrame: true };
const SUBFRAME: VoiceCaller = { senderId: 1, fromMainFrame: false };
const OTHER_WINDOW: VoiceCaller = { senderId: 2, fromMainFrame: true };
const frame = (): Float32Array => new Float32Array(VOICE_FRAME_SAMPLES).fill(0.2);

/** Faux worker : répond au protocole comme le vrai (`loaded`, états, `final`). */
class FakeWorker implements WorkerHandle {
  readonly received: MainToWorkerMessage[] = [];
  private listener: ((data: unknown) => void) | undefined;
  private readonly exitListeners: ((code: number) => void)[] = [];
  killed = false;
  failLoad = false;

  postMessage(message: MainToWorkerMessage): void {
    this.received.push(message);
    queueMicrotask(() => {
      switch (message.type) {
        case 'load':
          this.reply(
            this.failLoad
              ? {
                  type: 'error',
                  error: { code: 'voice/engine_failed', message: 'x', retryable: true },
                }
              : { type: 'loaded', loadMs: 10 },
          );
          return;
        case 'start':
          this.reply({ type: 'state', voiceSessionId: message.voiceSessionId, state: 'starting' });
          return;
        case 'stop':
          this.reply({
            type: 'final',
            voiceSessionId: message.voiceSessionId,
            text: 'Bonjour.',
            reason: 'stopped',
          });
          return;
        case 'shutdown':
          this.exit(0);
          return;
        default:
          return;
      }
    });
  }

  onMessage(listener: (data: unknown) => void): void {
    this.listener = listener;
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener);
  }

  kill(): void {
    this.killed = true;
    this.exit(1);
  }

  reply(data: unknown): void {
    this.listener?.(data);
  }

  exit(code: number): void {
    for (const listener of this.exitListeners) listener(code);
  }

  audioSeqs(): number[] {
    return this.received.flatMap((m) => (m.type === 'audio' ? [m.seq] : []));
  }
}

interface Harness {
  service: VoiceService;
  workers: FakeWorker[];
  events: { channel: IpcEventChannel; payload: unknown }[];
  settings: VoiceSettings;
  mic: { access: MicAccess; requested: number };
  installed: Set<string>;
  models: {
    install: ReturnType<typeof vi.fn>;
    importArchive: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
}

function harness(overrides: Partial<VoiceServiceOptions> = {}): Harness {
  const workers: FakeWorker[] = [];
  const events: Harness['events'] = [];
  const settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, enabled: true };
  const mic = { access: 'granted' as MicAccess, requested: 0 };
  const installed = new Set([SILERO_VAD.id, PARAKEET_TDT_V3_INT8.id]);
  const resolve = (id: string): Promise<ResolvedVoiceModel> => {
    if (!installed.has(id)) {
      return Promise.reject(new AtelierError('voice/model_missing', `Modèle non installé : ${id}`));
    }
    const files: Record<string, string> =
      id === SILERO_VAD.id ? { 'silero_vad.onnx': '/res/voice/silero_vad.onnx' } : {};
    const dir = id === SILERO_VAD.id ? '/res/voice' : `/models/voice/${id}@1`;
    return Promise.resolve({ id, version: '1', dir, files });
  };
  const models = {
    install: vi.fn(() => Promise.resolve()),
    importArchive: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
  };
  const service = new VoiceService({
    models: {
      ...models,
      resolve,
      status: () =>
        Promise.resolve(
          [SILERO_VAD, PARAKEET_TDT_V3_INT8].map((e) =>
            toModelInfo(e, installed.has(e.id) ? 'installed' : 'absent'),
          ),
        ),
    },
    spawnWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    settings: () => settings,
    mic: {
      status: () => mic.access,
      request: () => {
        mic.requested += 1;
        return Promise.resolve(mic.access);
      },
      openSettings: () => Promise.resolve(),
    },
    chooseArchive: () => Promise.resolve('/Users/a/Downloads/parakeet.tar.bz2'),
    emit: (channel, payload) => {
      events.push({ channel, payload });
    },
    newId: (() => {
      let n = 0;
      return () => `vs-${String(++n)}`;
    })(),
    supervisor: { exitGraceMs: 1 },
    ...overrides,
  });
  return { service, workers, events, settings, mic, installed, models };
}

async function expectCode(
  promise: Promise<unknown> | (() => unknown),
  code: AtelierErrorCode,
): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(isAtelierError(error) && error.code).toBe(code);
    return;
  }
  throw new Error(`${code} attendu`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceService : sessions', () => {
  it('ouvre une session, relaie les trames, rend le texte final', async () => {
    const h = harness();
    const { voiceSessionId } = await h.service.start(MAIN);
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0]?.received[0]).toEqual({
      type: 'load',
      config: {
        vadModel: '/res/voice/silero_vad.onnx',
        stt: {
          modelId: PARAKEET_TDT_V3_INT8.id,
          dir: `/models/voice/${PARAKEET_TDT_V3_INT8.id}@1`,
        },
      },
    });
    h.service.audio(MAIN, voiceSessionId, 0, frame());
    h.service.audio(MAIN, voiceSessionId, 1, frame());
    expect(await h.service.stop(MAIN, voiceSessionId)).toEqual({ text: 'Bonjour.' });
    expect(h.workers[0]?.audioSeqs()).toEqual([0, 1]);
    expect(h.service.activeSessionId).toBeUndefined();
    expect(h.events.some((e) => e.channel === 'voice:state')).toBe(true);
  });

  it('une seule session à la fois (voice/busy), même sur deux clics rapides', async () => {
    const h = harness();
    const first = h.service.start(MAIN);
    await expectCode(h.service.start(MAIN), 'voice/busy');
    await first;
    await expectCode(h.service.start(OTHER_WINDOW), 'voice/busy');
  });

  it('refuse la dictée sans accès au micro (voice/mic_denied)', async () => {
    const h = harness();
    h.mic.access = 'denied';
    await expectCode(h.service.start(MAIN), 'voice/mic_denied');
    h.mic.access = 'not-determined';
    await expectCode(h.service.start(MAIN), 'voice/mic_denied');
    expect(h.workers).toHaveLength(0);
    expect(h.mic.requested).toBe(0); // jamais de demande implicite
  });

  it('modèle absent : voice/model_missing, aucun worker lancé, la session est libérée', async () => {
    const h = harness();
    h.installed.delete(PARAKEET_TDT_V3_INT8.id);
    await expectCode(h.service.start(MAIN), 'voice/model_missing');
    expect(h.workers).toHaveLength(0);
    expect(h.service.activeSessionId).toBeUndefined();
  });

  it('refuse la voix à un sous-cadre (artefact, aperçu)', async () => {
    const h = harness();
    await expectCode(h.service.start(SUBFRAME), 'voice/mic_denied');
    const { voiceSessionId } = await h.service.start(MAIN);
    await expectCode(() => {
      h.service.audio(SUBFRAME, voiceSessionId, 0, frame());
    }, 'voice/mic_denied');
    await expectCode(h.service.stop(SUBFRAME, voiceSessionId), 'voice/mic_denied');
    expect(h.workers[0]?.audioSeqs()).toEqual([]);
  });

  it('refuse les trames et l’arrêt venus d’une autre fenêtre', async () => {
    const h = harness();
    const { voiceSessionId } = await h.service.start(MAIN);
    await expectCode(() => {
      h.service.audio(OTHER_WINDOW, voiceSessionId, 0, frame());
    }, 'voice/busy');
    await expectCode(h.service.stop(OTHER_WINDOW, voiceSessionId), 'voice/busy');
    expect(h.workers[0]?.audioSeqs()).toEqual([]);
  });

  it('ignore une trame hors d’une session active (trames en vol après l’arrêt)', async () => {
    const h = harness();
    h.service.audio(MAIN, 'inconnue', 0, frame());
    const { voiceSessionId } = await h.service.start(MAIN);
    h.service.audio(MAIN, 'autre-session', 0, frame());
    await h.service.stop(MAIN, voiceSessionId);
    h.service.audio(MAIN, voiceSessionId, 5, frame());
    expect(h.workers[0]?.audioSeqs()).toEqual([]);
  });

  it('refuse une trame invalide (type, taille, seq)', async () => {
    const h = harness();
    const { voiceSessionId } = await h.service.start(MAIN);
    for (const pcm of [
      [0.1, 0.2],
      new Float32Array(0),
      new Float32Array(16_001),
      new Float64Array(10),
    ]) {
      await expectCode(() => {
        h.service.audio(MAIN, voiceSessionId, 0, pcm);
      }, 'internal');
    }
    await expectCode(() => {
      h.service.audio(MAIN, voiceSessionId, -1, frame());
    }, 'internal');
    expect(h.workers[0]?.audioSeqs()).toEqual([]);
  });

  it('détecte la perte et le désordre des trames par seq', async () => {
    const log = vi.fn();
    const h = harness({ log });
    const { voiceSessionId } = await h.service.start(MAIN);
    for (const seq of [0, 1, 4, 3, 4, 5]) h.service.audio(MAIN, voiceSessionId, seq, frame());
    expect(h.workers[0]?.audioSeqs()).toEqual([0, 1, 4, 5]);
    await h.service.stop(MAIN, voiceSessionId);
    expect(h.service.lastSessionStats).toEqual({ lostFrames: 2, reorderedFrames: 2 });
    expect(log).toHaveBeenCalledWith('voice: trames du micro perdues ou en désordre', {
      lostFrames: 2,
      reorderedFrames: 2,
    });
  });

  it('annule une session : idle diffusé, plus de trames relayées', async () => {
    const h = harness();
    const { voiceSessionId } = await h.service.start(MAIN);
    h.service.cancel(MAIN, voiceSessionId);
    expect(h.workers[0]?.received.at(-1)).toEqual({ type: 'cancel', voiceSessionId });
    expect(h.events.at(-1)).toEqual({
      channel: 'voice:state',
      payload: { voiceSessionId, state: 'idle' },
    });
    h.service.audio(MAIN, voiceSessionId, 0, frame());
    expect(h.workers[0]?.audioSeqs()).toEqual([]);
    // Une seconde annulation est sans effet.
    h.service.cancel(MAIN, voiceSessionId);
  });

  it('fenêtre fermée ou mise en veille : la session est abandonnée', async () => {
    const h = harness();
    const first = await h.service.start(MAIN);
    h.service.senderGone(2); // une autre fenêtre : sans effet
    expect(h.service.activeSessionId).toBe(first.voiceSessionId);
    h.service.senderGone(1);
    expect(h.service.activeSessionId).toBeUndefined();
    await h.service.start(MAIN);
    h.service.suspend();
    expect(h.service.activeSessionId).toBeUndefined();
  });
});

describe('VoiceService : cycle de vie du worker', () => {
  it('relance un worker neuf après un crash', async () => {
    const h = harness();
    const { voiceSessionId } = await h.service.start(MAIN);
    h.workers[0]?.exit(9);
    expect(h.service.activeSessionId).toBeUndefined();
    expect(h.events).toContainEqual({
      channel: 'voice:state',
      payload: { voiceSessionId, state: 'idle' },
    });
    expect((await h.service.status()).engine).toBe('error');
    await h.service.start(MAIN);
    expect(h.workers).toHaveLength(2);
    expect((await h.service.status()).engine).toBe('ready');
  });

  it('libère le moteur après l’inactivité réglée', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { voiceSessionId } = await h.service.start(MAIN);
    await h.service.stop(MAIN, voiceSessionId);
    h.service.settingsChanged({ ...h.settings, idleUnloadMinutes: 1 }, h.settings);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.workers[0]?.received.at(-1)?.type).not.toBe('shutdown');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.workers[0]?.received.at(-1)).toEqual({ type: 'shutdown' });
    expect((await h.service.status()).engine).toBe('stopped');
  });

  it('voix désactivée dans les Réglages : moteur libéré', async () => {
    const h = harness();
    const { voiceSessionId } = await h.service.start(MAIN);
    await h.service.stop(MAIN, voiceSessionId);
    h.service.settingsChanged({ ...h.settings, enabled: false }, h.settings);
    expect(h.workers[0]?.received.at(-1)).toEqual({ type: 'shutdown' });
  });

  it('marque « chargé » les modèles du moteur prêt', async () => {
    const h = harness();
    const before = await h.service.status();
    expect(before.models.map((m) => m.state)).toEqual(['installed', 'installed']);
    await h.service.start(MAIN);
    const after = await h.service.status();
    expect(after.models.map((m) => m.state)).toEqual(['loaded', 'loaded']);
  });

  it('préchargement au démarrage : seulement voix active et 32 Go ou plus', async () => {
    const small = harness();
    await small.service.preload(16 * 1024 ** 3);
    expect(small.workers).toHaveLength(0);
    const off = harness();
    off.settings.enabled = false;
    await off.service.preload(64 * 1024 ** 3);
    expect(off.workers).toHaveLength(0);
    const big = harness();
    await big.service.preload(64 * 1024 ** 3);
    expect(big.workers).toHaveLength(1);
    expect((await big.service.status()).engine).toBe('ready');
  });

  it('un échec du préchargement reste silencieux', async () => {
    const h = harness();
    h.installed.delete(PARAKEET_TDT_V3_INT8.id);
    await expect(h.service.preload(64 * 1024 ** 3)).resolves.toBeUndefined();
  });
});

describe('VoiceService : modèles et micro', () => {
  it('installe depuis le miroir des Réglages', async () => {
    const h = harness();
    await h.service.installModel(PARAKEET_TDT_V3_INT8.id);
    expect(h.models.install).toHaveBeenLastCalledWith(PARAKEET_TDT_V3_INT8.id, {});
    h.settings.modelSourceUrl = 'https://mirror.example.be/voice';
    await h.service.installModel(PARAKEET_TDT_V3_INT8.id);
    expect(h.models.install).toHaveBeenLastCalledWith(PARAKEET_TDT_V3_INT8.id, {
      sourceUrl: 'https://mirror.example.be/voice',
    });
  });

  it('importe l’archive choisie ; rien si le sélecteur est annulé', async () => {
    const h = harness();
    await h.service.importModel(PARAKEET_TDT_V3_INT8.id);
    expect(h.models.importArchive).toHaveBeenCalledWith(
      PARAKEET_TDT_V3_INT8.id,
      '/Users/a/Downloads/parakeet.tar.bz2',
    );
    const cancelled = harness({ chooseArchive: () => Promise.resolve(null) });
    await cancelled.service.importModel(PARAKEET_TDT_V3_INT8.id);
    expect(cancelled.models.importArchive).not.toHaveBeenCalled();
  });

  it('refuse de supprimer le modèle en cours de dictée, puis libère le moteur avant suppression', async () => {
    const h = harness();
    const { voiceSessionId } = await h.service.start(MAIN);
    await expectCode(h.service.removeModel(PARAKEET_TDT_V3_INT8.id), 'voice/busy');
    await h.service.stop(MAIN, voiceSessionId);
    await h.service.removeModel(PARAKEET_TDT_V3_INT8.id);
    expect(h.workers[0]?.received.at(-1)).toEqual({ type: 'shutdown' });
    expect(h.models.remove).toHaveBeenCalledWith(PARAKEET_TDT_V3_INT8.id);
  });

  it('relaie la progression des modèles et l’état global', async () => {
    const h = harness();
    const downloading: VoiceModelInfo = toModelInfo(PARAKEET_TDT_V3_INT8, 'downloading', {
      progress: { receivedBytes: 1, totalBytes: 2 },
    });
    h.service.modelChanged(downloading);
    expect(h.events).toEqual([{ channel: 'voice:model', payload: downloading }]);
    h.service.modelChanged(toModelInfo(PARAKEET_TDT_V3_INT8, 'installed'));
    await vi.waitFor(() => {
      expect(h.events.at(-1)?.channel).toBe('voice:status');
    });
  });

  it('demande l’accès au micro seulement sur requête explicite', async () => {
    const h = harness();
    h.mic.access = 'not-determined';
    expect((await h.service.status()).mic).toBe('not-determined');
    expect(h.mic.requested).toBe(0);
    await h.service.requestMic();
    expect(h.mic.requested).toBe(1);
  });
});
