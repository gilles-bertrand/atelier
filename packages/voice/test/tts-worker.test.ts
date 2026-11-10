/**
 * Synthèse (L7) dans le worker et le superviseur : chargement à la demande,
 * file indépendante de la dictée, erreurs sans le texte, crash et inactivité.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechSynthesizer } from '../src/engine.js';
import type { TtsLoadConfig, WorkerToMainMessage } from '../src/protocol.js';
import { AgentSpeech } from '../src/speech.js';
import { VoiceWorkerSupervisor } from '../src/supervisor.js';
import { runVoiceWorker } from '../src/worker.js';
import { FakeEngine, FakeSynthesizer, deferred, flushMicrotasks, speechFrame } from './fakes.js';
import { createFakeWorker, type FakeWorker } from './harness.js';

const loadConfig = {
  vadModel: '/models/silero_vad.onnx',
  stt: { modelId: 'parakeet-tdt-0.6b-v3-int8', dir: '/models/parakeet' },
};
const ttsConfig = { voice: 'supertonic-3-m4', dir: '/models/supertonic' };

function workerSetup(synth: FakeSynthesizer | (() => Promise<SpeechSynthesizer>)) {
  const sent: WorkerToMainMessage[] = [];
  const configs: TtsLoadConfig[] = [];
  let listener: (data: unknown) => void = () => undefined;
  runVoiceWorker({
    port: { postMessage: (m) => sent.push(m), onMessage: (l) => (listener = l) },
    createEngine: () => Promise.resolve(new FakeEngine({ script: ['Bonjour.', 'Bonjour.'] })),
    createSynthesizer: (config) => {
      configs.push(config);
      return typeof synth === 'function' ? synth() : Promise.resolve(synth);
    },
    exit: () => undefined,
  });
  const send = async (data: unknown): Promise<void> => {
    listener(data);
    await flushMicrotasks(20);
  };
  return { sent, send, configs };
}

describe('worker : synthèse', () => {
  it('charge la voix à la demande, puis synthétise chaque morceau', async () => {
    const synth = new FakeSynthesizer();
    const { sent, send, configs } = workerSetup(synth);
    await send({ type: 'tts-load', config: ttsConfig });
    expect(sent.at(-1)).toMatchObject({ type: 'tts-loaded', sampleRate: 44_100 });
    expect(configs[0]).toEqual({ ...ttsConfig, numThreads: 2 });
    await send({ type: 'speak', requestId: 0, text: 'Bonjour Gilles,', speed: 1.1 });
    const speech = sent.at(-1);
    expect(speech).toMatchObject({ type: 'speech', requestId: 0, sampleRate: 44_100 });
    if (speech?.type !== 'speech') throw new Error('speech attendu');
    expect(speech.pcm).toHaveLength(150);
    expect(synth.calls).toEqual([{ text: 'Bonjour Gilles,', options: { speed: 1.1 } }]);
    // Même configuration : pas de rechargement.
    await send({ type: 'tts-load', config: ttsConfig });
    expect(sent.at(-1)).toMatchObject({ type: 'tts-loaded', loadMs: 0 });
    expect(configs).toHaveLength(1);
  });

  it('refuse de parler sans voix chargée', async () => {
    const { sent, send } = workerSetup(new FakeSynthesizer());
    await send({ type: 'speak', requestId: 3, text: 'Bonjour.', speed: 1 });
    expect(sent.at(-1)).toMatchObject({
      type: 'tts-error',
      requestId: 3,
      error: { code: 'voice/engine_failed' },
    });
  });

  it('ne recopie jamais le texte ni l’erreur native', async () => {
    const synth = new FakeSynthesizer({ failOn: 'Le solde du client Nox est négatif.' });
    const { sent, send } = workerSetup(synth);
    await send({ type: 'tts-load', config: ttsConfig });
    await send({
      type: 'speak',
      requestId: 1,
      text: 'Le solde du client Nox est négatif.',
      speed: 1,
    });
    expect(sent.at(-1)).toMatchObject({ type: 'tts-error', requestId: 1 });
    expect(JSON.stringify(sent)).not.toContain('Nox');
  });

  it('signale l’échec du chargement de la voix sans recopier l’erreur native', async () => {
    const { sent, send } = workerSetup(() =>
      Promise.reject(new Error('/Users/x/voice.bin: corrupt')),
    );
    await send({ type: 'tts-load', config: ttsConfig });
    expect(sent.at(-1)).toMatchObject({
      type: 'tts-error',
      error: { code: 'voice/engine_failed' },
    });
    expect(sent.at(-1)).not.toHaveProperty('requestId');
    expect(JSON.stringify(sent)).not.toContain('corrupt');
  });

  it('une synthèse en cours ne bloque pas la dictée', async () => {
    const gate = deferred();
    const synth = new FakeSynthesizer({ gate: () => gate.promise });
    const { sent, send } = workerSetup(synth);
    await send({ type: 'load', config: loadConfig });
    await send({ type: 'tts-load', config: ttsConfig });
    await send({ type: 'speak', requestId: 0, text: 'Une longue phrase.', speed: 1 });
    // La synthèse attend ; la dictée démarre et transcrit quand même.
    await send({ type: 'start', voiceSessionId: 'v1' });
    await send({ type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: speechFrame() });
    await send({ type: 'stop', voiceSessionId: 'v1' });
    expect(sent.some((m) => m.type === 'final')).toBe(true);
    expect(sent.some((m) => m.type === 'speech')).toBe(false);
    gate.resolve();
    await flushMicrotasks(20);
    expect(sent.at(-1)).toMatchObject({ type: 'speech', requestId: 0 });
  });

  it('sans fabrique de synthèse, tts-load échoue proprement', async () => {
    const sent: WorkerToMainMessage[] = [];
    let listener: (data: unknown) => void = () => undefined;
    runVoiceWorker({
      port: { postMessage: (m) => sent.push(m), onMessage: (l) => (listener = l) },
      createEngine: () => Promise.resolve(new FakeEngine()),
      exit: () => undefined,
    });
    listener({ type: 'tts-load', config: ttsConfig });
    await flushMicrotasks(20);
    expect(sent.at(-1)).toMatchObject({
      type: 'tts-error',
      error: { code: 'voice/engine_failed' },
    });
  });
});

/** Avance l'horloge en laissant les messages en vol aller et venir. */
async function tick(ms = 0): Promise<void> {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1);
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1);
}

function supervisorSetup(
  options: {
    synth?: () => Promise<SpeechSynthesizer>;
    ttsLoadConfig?: () => typeof ttsConfig;
    idleUnloadMinutes?: number;
    speakTimeoutMs?: number;
  } = {},
) {
  const workers: FakeWorker[] = [];
  const supervisor = new VoiceWorkerSupervisor({
    spawn: () => {
      const w = createFakeWorker(
        () => Promise.resolve(new FakeEngine({ script: ['Bonjour.', 'Bonjour.'] })),
        options.synth ?? (() => Promise.resolve(new FakeSynthesizer())),
      );
      workers.push(w);
      return w;
    },
    loadConfig: () => loadConfig,
    ttsLoadConfig: options.ttsLoadConfig ?? (() => ttsConfig),
    ...(options.idleUnloadMinutes !== undefined
      ? { idleUnloadMinutes: options.idleUnloadMinutes }
      : {}),
    ...(options.speakTimeoutMs !== undefined ? { speakTimeoutMs: options.speakTimeoutMs } : {}),
  });
  return { supervisor, workers };
}

describe('VoiceWorkerSupervisor : synthèse', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lance le worker, charge la voix à la demande et rend l’audio', async () => {
    const { supervisor, workers } = supervisorSetup();
    const result = supervisor.synthesize('Bonjour Gilles,', 1);
    await tick();
    await expect(result).resolves.toMatchObject({ sampleRate: 44_100 });
    expect(workers).toHaveLength(1);
    const types = workers[0]?.sent.map((m) => m.type);
    expect(types).toEqual(['ready', 'loaded', 'tts-loaded', 'speech']);
    // Deuxième morceau : ni relance ni rechargement.
    const again = supervisor.synthesize('Suite.', 1);
    await tick();
    await again;
    expect(workers[0]?.sent.filter((m) => m.type === 'tts-loaded')).toHaveLength(1);
  });

  it('sert de port à AgentSpeech : VoiceAudioOut dans l’ordre, final en dernier', async () => {
    const { supervisor } = supervisorSetup();
    const out: { seq: number; final: boolean; len: number }[] = [];
    const speech = new AgentSpeech({
      voiceSessionId: 'v1',
      synthesizer: supervisor,
      onAudio: (c) => out.push({ seq: c.seq, final: c.final, len: c.pcm.length }),
    });
    speech.begin('t1');
    speech.push('t1', 'Bonjour Gilles, je lance l’analyse des ventes. Elle prend 2 min.');
    speech.end('t1');
    for (let i = 0; i < 5; i += 1) await tick();
    expect(out.map((c) => [c.seq, c.final])).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);
    expect(out[0]?.len).toBe('Bonjour Gilles,'.length * 10);
  });

  it('modèle de synthèse absent : rien n’est envoyé au worker', async () => {
    const { supervisor, workers } = supervisorSetup({
      ttsLoadConfig: () => {
        throw Object.assign(new Error('absent'), { code: 'voice/model_missing' });
      },
    });
    await expect(supervisor.synthesize('Bonjour.', 1)).rejects.toThrow();
    expect(workers).toHaveLength(0);
  });

  it('échec du chargement de la voix : la reconnaissance reste, le prochain appel réessaie', async () => {
    let attempts = 0;
    const { supervisor, workers } = supervisorSetup({
      synth: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('corrupt'))
          : Promise.resolve(new FakeSynthesizer());
      },
    });
    const first = supervisor.synthesize('Bonjour.', 1);
    const failure = expect(first).rejects.toMatchObject({ code: 'voice/engine_failed' });
    await tick();
    await failure;
    expect(supervisor.engineState).toBe('ready');
    const second = supervisor.synthesize('Bonjour.', 1);
    await tick();
    await expect(second).resolves.toMatchObject({ sampleRate: 44_100 });
    expect(workers).toHaveLength(1);
  });

  it('crash du worker : les synthèses en cours échouent et la voix sera rechargée', async () => {
    const gate = deferred();
    const { supervisor, workers } = supervisorSetup({
      synth: () => Promise.resolve(new FakeSynthesizer({ gate: () => gate.promise })),
    });
    const pending = supervisor.synthesize('Bonjour.', 1);
    const failure = expect(pending).rejects.toMatchObject({ code: 'voice/engine_failed' });
    await tick();
    workers[0]?.crash();
    await tick();
    await failure;
    gate.resolve();
    const again = supervisor.synthesize('Bonjour.', 1);
    await tick();
    await again;
    expect(workers).toHaveLength(2);
    expect(workers[1]?.sent.map((m) => m.type)).toContain('tts-loaded');
  });

  it('ne décharge pas le worker pendant une synthèse', async () => {
    const gate = deferred();
    const { supervisor, workers } = supervisorSetup({
      idleUnloadMinutes: 1,
      speakTimeoutMs: 10 * 60_000,
      synth: () => Promise.resolve(new FakeSynthesizer({ gate: () => gate.promise })),
    });
    const pending = supervisor.synthesize('Bonjour.', 1);
    await tick(2 * 60_000);
    expect(workers[0]?.exited).toBe(false);
    gate.resolve();
    await tick();
    await pending;
    await tick(61_000);
    expect(workers[0]?.exited).toBe(true);
  });

  it('une synthèse trop longue expire et retire le worker', async () => {
    const { supervisor } = supervisorSetup({
      synth: () =>
        Promise.resolve(new FakeSynthesizer({ gate: () => new Promise(() => undefined) })),
    });
    const pending = supervisor.synthesize('Bonjour.', 1);
    const failure = expect(pending).rejects.toMatchObject({ code: 'voice/engine_failed' });
    await tick(31_000);
    await failure;
    expect(supervisor.engineState).toBe('error');
  });

  it('sans ttsLoadConfig, la synthèse n’est pas disponible', async () => {
    const supervisor = new VoiceWorkerSupervisor({
      spawn: () => createFakeWorker(() => Promise.resolve(new FakeEngine())),
      loadConfig: () => loadConfig,
    });
    await expect(supervisor.synthesize('Bonjour.', 1)).rejects.toMatchObject({
      code: 'voice/engine_failed',
    });
  });
});
