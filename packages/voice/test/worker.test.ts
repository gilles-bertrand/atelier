import { describe, expect, it } from 'vitest';
import type { WorkerToMainMessage } from '../src/protocol.js';
import { runVoiceWorker } from '../src/worker.js';
import { FakeEngine, deferred, flushMicrotasks, silenceFrame, speechFrame } from './fakes.js';

const loadConfig = {
  vadModel: '/models/silero_vad.onnx',
  stt: { modelId: 'parakeet-tdt-0.6b-v3-int8', dir: '/models/parakeet' },
};

/** Premier segment, puis le bloc final retranscrit à l'arrêt (#42). */
function setup(engine = new FakeEngine({ script: ['Bonjour.', 'Bonjour, au revoir !'] })) {
  const sent: WorkerToMainMessage[] = [];
  let listener: (data: unknown) => void = () => undefined;
  let exited = 0;
  runVoiceWorker({
    port: {
      postMessage: (m) => sent.push(m),
      onMessage: (l) => {
        listener = l;
      },
    },
    createEngine: () => Promise.resolve(engine),
    exit: () => {
      exited += 1;
    },
  });
  const send = async (data: unknown): Promise<void> => {
    listener(data);
    await flushMicrotasks(20);
  };
  return { sent, send, engine, exits: () => exited };
}

const types = (sent: WorkerToMainMessage[]) => sent.map((m) => m.type);

describe('runVoiceWorker', () => {
  it('annonce son démarrage, charge le moteur et mène une dictée', async () => {
    const { sent, send } = setup();
    expect(types(sent)).toEqual(['ready']);
    await send({ type: 'load', config: loadConfig });
    expect(sent[1]).toMatchObject({ type: 'loaded' });

    await send({ type: 'start', voiceSessionId: 'v1' });
    await send({ type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: speechFrame() });
    await send({ type: 'audio', voiceSessionId: 'v1', seq: 1, pcm: silenceFrame() });
    await send({ type: 'audio', voiceSessionId: 'v1', seq: 2, pcm: speechFrame() });
    await send({ type: 'stop', voiceSessionId: 'v1' });

    expect(sent.find((m) => m.type === 'final')).toEqual({
      type: 'final',
      voiceSessionId: 'v1',
      text: 'Bonjour, au revoir !',
      reason: 'stopped',
    });
    expect(sent.filter((m) => m.type === 'transcript')).toHaveLength(1);
    expect(sent.flatMap((m) => (m.type === 'state' ? [m.state] : []))).toEqual([
      'starting',
      'listening',
      'transcribing',
      'idle',
    ]);
  });

  it('rejette un message invalide sans l’exécuter ni recopier son contenu', async () => {
    const { sent, send, engine } = setup();
    await send({ type: 'load', config: { ...loadConfig, vadModel: '../../etc/passwd' } });
    await send({ type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: 'secret' });
    await send(null);
    const rejected = sent.filter((m) => m.type === 'rejected');
    expect(rejected).toEqual([
      { type: 'rejected', issue: 'config.vadModel' },
      { type: 'rejected', issue: 'pcm' },
      { type: 'rejected', issue: 'message' },
    ]);
    expect(JSON.stringify(sent)).not.toContain('passwd');
    expect(JSON.stringify(sent)).not.toContain('secret');
    expect(engine.segmenters).toHaveLength(0);
  });

  it('refuse une seconde session (voice/busy) et une session sans moteur', async () => {
    const { sent, send } = setup();
    await send({ type: 'start', voiceSessionId: 'v0' });
    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      voiceSessionId: 'v0',
      error: { code: 'voice/engine_failed' },
    });
    await send({ type: 'load', config: loadConfig });
    await send({ type: 'start', voiceSessionId: 'v1' });
    await send({ type: 'start', voiceSessionId: 'v2' });
    expect(sent.at(-1)).toMatchObject({
      type: 'error',
      voiceSessionId: 'v2',
      error: { code: 'voice/busy' },
    });
  });

  it('annule sans attendre une transcription en cours', async () => {
    const gate = deferred();
    const engine = new FakeEngine({ script: ['Secret.'], gate: () => gate.promise });
    const { sent, send } = setup(engine);
    await send({ type: 'load', config: loadConfig });
    await send({ type: 'start', voiceSessionId: 'v1' });
    await send({ type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: speechFrame() });
    await send({ type: 'stop', voiceSessionId: 'v1' });
    await send({ type: 'cancel', voiceSessionId: 'v1' });
    gate.resolve();
    await flushMicrotasks(20);
    expect(types(sent)).not.toContain('final');
    expect(types(sent)).not.toContain('transcript');
    expect(JSON.stringify(sent)).not.toContain('Secret');
    // Une nouvelle session peut démarrer.
    await send({ type: 'start', voiceSessionId: 'v2' });
    expect(sent.at(-1)).toMatchObject({ type: 'state', voiceSessionId: 'v2', state: 'starting' });
  });

  it('ignore les trames hors session', async () => {
    const { sent, send, engine } = setup();
    await send({ type: 'load', config: loadConfig });
    await send({ type: 'audio', voiceSessionId: 'autre', seq: 0, pcm: speechFrame() });
    expect(types(sent)).toEqual(['ready', 'loaded']);
    expect(engine.segmenters).toHaveLength(0);
  });

  it('envoie le texte final à la durée maximale', async () => {
    const { sent, send } = setup(new FakeEngine({ script: ['Très long.'] }));
    await send({ type: 'load', config: loadConfig });
    await send({ type: 'start', voiceSessionId: 'v1', maxDurationMs: 1000 });
    for (let seq = 0; seq < 10; seq += 1) {
      await send({ type: 'audio', voiceSessionId: 'v1', seq, pcm: speechFrame() });
    }
    expect(sent.find((m) => m.type === 'final')).toEqual({
      type: 'final',
      voiceSessionId: 'v1',
      text: 'Très long.',
      reason: 'max_duration',
    });
  });

  it('libère le moteur et sort sur shutdown', async () => {
    const { send, engine, exits } = setup();
    await send({ type: 'load', config: loadConfig });
    await send({ type: 'shutdown' });
    expect(engine.disposed).toBe(true);
    expect(exits()).toBe(1);
  });

  it('signale l’échec du chargement sans recopier l’erreur native', async () => {
    const sent: WorkerToMainMessage[] = [];
    let listener: (data: unknown) => void = () => undefined;
    runVoiceWorker({
      port: { postMessage: (m) => sent.push(m), onMessage: (l) => (listener = l) },
      createEngine: () => Promise.reject(new Error('/Users/x/model: invalid protobuf')),
      exit: () => undefined,
    });
    listener({ type: 'load', config: loadConfig });
    await flushMicrotasks(20);
    expect(sent.at(-1)).toMatchObject({ type: 'error', error: { code: 'voice/engine_failed' } });
    expect(JSON.stringify(sent)).not.toContain('protobuf');
  });
});

describe('runVoiceWorker, mode conversation (L9)', () => {
  it('signale la reprise de parole et la fin du tour', async () => {
    const { sent, send } = setup(new FakeEngine({ script: ['Bonjour.', 'Bonjour.'] }));
    await send({ type: 'load', config: loadConfig });
    await send({ type: 'start', voiceSessionId: 'v1', endOfTurnSilenceMs: 300 });
    await send({ type: 'audio', voiceSessionId: 'v1', seq: 0, pcm: speechFrame() });
    for (let seq = 1; seq <= 3; seq += 1) {
      await send({ type: 'audio', voiceSessionId: 'v1', seq, pcm: silenceFrame() });
    }
    expect(sent.filter((m) => m.type === 'speech-start')).toEqual([
      { type: 'speech-start', voiceSessionId: 'v1' },
    ]);
    expect(sent.filter((m) => m.type === 'turn-end')).toEqual([
      { type: 'turn-end', voiceSessionId: 'v1' },
    ]);
  });

  it('refuse un silence de fin de tour hors bornes', async () => {
    const { sent, send } = setup();
    await send({ type: 'load', config: loadConfig });
    await send({ type: 'start', voiceSessionId: 'v1', endOfTurnSilenceMs: 50 });
    expect(sent.at(-1)).toEqual({ type: 'rejected', issue: 'endOfTurnSilenceMs' });
  });
});
