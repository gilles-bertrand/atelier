import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtelierError, type VoiceEngineState } from '@atelier/shared';
import type { SpeechEngine } from '../src/engine.js';
import { VoiceWorkerSupervisor } from '../src/supervisor.js';
import { FakeEngine, silenceFrame, speechFrame } from './fakes.js';
import { createFakeWorker, type FakeWorker } from './harness.js';

const loadConfig = {
  vadModel: '/models/silero_vad.onnx',
  stt: { modelId: 'parakeet-tdt-0.6b-v3-int8', dir: '/models/parakeet' },
};

function setup(
  options: {
    idleUnloadMinutes?: number;
    createEngine?: () => Promise<SpeechEngine>;
    loadConfig?: () => typeof loadConfig;
  } = {},
) {
  const workers: FakeWorker[] = [];
  const engineStates: VoiceEngineState[] = [];
  const sessionErrors: AtelierError[] = [];
  const transcripts: string[] = [];
  const autoStops: string[] = [];
  const supervisor = new VoiceWorkerSupervisor({
    spawn: () => {
      const w = createFakeWorker(
        options.createEngine ??
          (() => Promise.resolve(new FakeEngine({ script: ['Bonjour.', 'Bonjour.'] }))),
      );
      workers.push(w);
      return w;
    },
    loadConfig: options.loadConfig ?? (() => loadConfig),
    ...(options.idleUnloadMinutes !== undefined
      ? { idleUnloadMinutes: options.idleUnloadMinutes }
      : {}),
    onEngineState: (s) => engineStates.push(s),
    onSessionError: (_id, e) => sessionErrors.push(e),
    onTranscript: (s) => transcripts.push(s.text),
    onAutoStop: (_id, text) => autoStops.push(text),
  });
  return { supervisor, workers, engineStates, sessionErrors, transcripts, autoStops };
}

/**
 * Avance l'horloge en laissant les messages en vol (setTimeout 0) aller et venir.
 * Pas de 1 ms : un setTimeout 0 posé pendant `advanceTimersByTimeAsync(0)` n'est pas exécuté.
 */
async function tick(ms = 0): Promise<void> {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1);
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1);
}

async function dictate(supervisor: VoiceWorkerSupervisor, id: string): Promise<string> {
  await supervisor.start(id);
  supervisor.audio(id, 0, speechFrame());
  supervisor.audio(id, 1, silenceFrame());
  const text = supervisor.stop(id);
  await tick(10);
  return text;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceWorkerSupervisor', () => {
  it('lance le worker au premier usage et rend le texte de la dictée', async () => {
    const { supervisor, workers, engineStates, transcripts } = setup();
    expect(workers).toHaveLength(0);
    const start = supervisor.start('v1');
    await tick();
    await start;
    expect(workers).toHaveLength(1);
    expect(supervisor.engineState).toBe('ready');
    supervisor.audio('v1', 0, speechFrame());
    const text = supervisor.stop('v1');
    await tick(10);
    expect(await text).toBe('Bonjour.');
    // Segment fermé par l'arrêt : repris dans le bloc final, sans transcription à part (#42).
    expect(transcripts).toEqual([]);
    expect(engineStates).toEqual(['loading', 'ready']);
    expect(supervisor.activeSessionId).toBeUndefined();
  });

  it('refuse une seconde session (voice/busy)', async () => {
    const { supervisor } = setup();
    const first = supervisor.start('v1');
    await tick();
    await first;
    await expect(supervisor.start('v2')).rejects.toMatchObject({ code: 'voice/busy' });
  });

  it('arrête le worker après idleUnloadMinutes d’inactivité', async () => {
    const { supervisor, workers, engineStates } = setup({ idleUnloadMinutes: 10 });
    const text = dictate(supervisor, 'v1');
    await tick();
    expect(await text).toBe('Bonjour.');
    await tick(9 * 60_000);
    expect(workers[0]?.exited).toBe(false);
    await tick(60_000);
    expect(workers[0]?.exited).toBe(true);
    expect(workers[0]?.killed).toBe(false);
    expect(supervisor.engineState).toBe('stopped');
    expect(engineStates).toEqual(['loading', 'ready', 'stopped']);

    // Relancé à la demande.
    const again = dictate(supervisor, 'v2');
    await tick();
    expect(await again).toBe('Bonjour.');
    expect(workers).toHaveLength(2);
  });

  it('ne compte pas l’inactivité pendant une dictée', async () => {
    const { supervisor, workers } = setup({ idleUnloadMinutes: 1 });
    const start = supervisor.start('v1');
    await tick();
    await start;
    await tick(5 * 60_000);
    expect(workers[0]?.exited).toBe(false);
    supervisor.cancel('v1');
    await tick(60_000);
    expect(workers[0]?.exited).toBe(true);
  });

  it('garde le worker chargé avec idleUnloadMinutes = 0', async () => {
    const { supervisor, workers } = setup({ idleUnloadMinutes: 0 });
    const text = dictate(supervisor, 'v1');
    await tick();
    await text;
    await tick(24 * 60 * 60_000);
    expect(workers[0]?.exited).toBe(false);
    supervisor.setIdleUnloadMinutes(2);
    await tick(2 * 60_000);
    expect(workers[0]?.exited).toBe(true);
  });

  it('tue le worker qui ne sort pas après shutdown', async () => {
    const { supervisor, workers } = setup();
    const loaded = supervisor.ensureLoaded();
    await tick();
    await loaded;
    const worker = workers[0];
    if (!worker) throw new Error('worker absent');
    // Le worker ne traite plus rien : shutdown reste sans effet.
    worker.postMessage = () => undefined;
    supervisor.shutdown();
    await tick(2_000);
    expect(worker.killed).toBe(true);
  });

  it('redémarre après un crash : la session échoue, la suivante relance un worker', async () => {
    const { supervisor, workers, sessionErrors, engineStates } = setup();
    const start = supervisor.start('v1');
    await tick();
    await start;
    supervisor.audio('v1', 0, speechFrame());
    const stopped = supervisor.stop('v1').catch((e: unknown) => e);
    workers[0]?.crash();
    await tick(10);
    const error = await stopped;
    expect(error).toBeInstanceOf(AtelierError);
    expect((error as AtelierError).code).toBe('voice/engine_failed');
    expect(sessionErrors.map((e) => e.code)).toEqual(['voice/engine_failed']);
    expect(supervisor.engineState).toBe('error');
    expect(supervisor.activeSessionId).toBeUndefined();

    const text = dictate(supervisor, 'v2');
    await tick();
    expect(await text).toBe('Bonjour.');
    expect(workers).toHaveLength(2);
    expect(engineStates).toEqual(['loading', 'ready', 'error', 'loading', 'ready']);
  });

  it('remonte un échec de chargement et retente au prochain usage', async () => {
    let attempts = 0;
    const { supervisor, workers } = setup({
      createEngine: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('fichier corrompu'))
          : Promise.resolve(new FakeEngine({ script: ['Ok.', 'Ok.'] }));
      },
    });
    const first = supervisor.start('v1').catch((e: unknown) => e);
    await tick(10);
    expect(await first).toMatchObject({ code: 'voice/engine_failed' });
    expect(workers[0]?.killed).toBe(true);
    expect(supervisor.activeSessionId).toBeUndefined();
    const text = dictate(supervisor, 'v2');
    await tick();
    expect(await text).toBe('Ok.');
  });

  it('expire si le chargement ne répond pas', async () => {
    const { supervisor } = setup({
      createEngine: () => new Promise<SpeechEngine>(() => undefined),
    });
    const loaded = supervisor.ensureLoaded().catch((e: unknown) => e);
    await tick(60_000);
    expect(await loaded).toMatchObject({ code: 'voice/engine_failed' });
    expect(supervisor.engineState).toBe('error');
  });

  it('ne lance aucun worker quand le modèle manque', async () => {
    const { supervisor, workers } = setup({
      loadConfig: () => {
        throw new AtelierError('voice/model_missing', 'Modèle absent.');
      },
    });
    await expect(supervisor.start('v1')).rejects.toMatchObject({ code: 'voice/model_missing' });
    expect(workers).toHaveLength(0);
    expect(supervisor.activeSessionId).toBeUndefined();
  });

  it('ignore les messages invalides du worker', async () => {
    const { supervisor, workers, transcripts } = setup();
    const start = supervisor.start('v1');
    await tick();
    await start;
    workers[0]?.emit({ type: 'transcript', segment: { text: 'injecté' } });
    workers[0]?.emit({ type: 'final', voiceSessionId: 'v1', text: 'x', reason: 'parce que' });
    workers[0]?.emit('n’importe quoi');
    expect(transcripts).toEqual([]);
    expect(supervisor.activeSessionId).toBe('v1');
  });

  it('relaie l’arrêt automatique à la durée maximale', async () => {
    const { supervisor, autoStops } = setup();
    const start = supervisor.start('v1', 1000);
    await tick();
    await start;
    for (let seq = 0; seq < 10; seq += 1) supervisor.audio('v1', seq, speechFrame());
    await tick(10);
    expect(autoStops).toEqual(['Bonjour.']);
    expect(supervisor.activeSessionId).toBeUndefined();
  });

  it('ignore les trames et l’arrêt d’une autre session', async () => {
    const { supervisor, workers } = setup();
    const start = supervisor.start('v1');
    await tick();
    await start;
    supervisor.audio('v2', 0, speechFrame());
    await expect(supervisor.stop('v2')).rejects.toMatchObject({ code: 'voice/engine_failed' });
    await tick(10);
    expect(workers[0]?.sent.filter((m) => m.type === 'state')).toHaveLength(1);
  });
});
