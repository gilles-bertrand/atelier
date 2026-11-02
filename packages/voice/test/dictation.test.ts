import { describe, expect, it } from 'vitest';
import { AtelierError, VOICE_FRAME_SAMPLES, type TranscriptSegment } from '@atelier/shared';
import { AudioHistory, DictationSession } from '../src/dictation.js';
import { NNBSP } from '../src/typography.js';
import {
  FakeEngine,
  deferred,
  flushMicrotasks,
  silenceFrame,
  speechFrame,
  zeroFrame,
} from './fakes.js';

function collect(engine: FakeEngine, maxDurationMs?: number) {
  const segments: TranscriptSegment[] = [];
  const states: string[] = [];
  const autoStops: string[] = [];
  const errors: AtelierError[] = [];
  const session = new DictationSession(
    { voiceSessionId: 'v1', engine, ...(maxDurationMs ? { maxDurationMs } : {}) },
    {
      onSegment: (s) => segments.push(s),
      onState: (s, w) => states.push(w ? `${s}:${w}` : s),
      onAutoStop: (t) => autoStops.push(t),
      onError: (e) => errors.push(e),
    },
  );
  return { session, segments, states, autoStops, errors };
}

describe('AudioHistory', () => {
  it('rend les échantillons encore présents dans le tampon circulaire', () => {
    const h = new AudioHistory(4);
    h.push(Float32Array.from([1, 2, 3]));
    h.push(Float32Array.from([4, 5, 6]));
    expect(h.totalSamples).toBe(6);
    expect(Array.from(h.slice(0, 6))).toEqual([3, 4, 5, 6]);
    expect(Array.from(h.slice(3, 5))).toEqual([4, 5]);
    h.clear();
    expect(h.slice(0, 6).length).toBe(0);
  });

  it('garde les derniers échantillons d’une trame plus grande que le tampon', () => {
    const h = new AudioHistory(2);
    h.push(Float32Array.from([1, 2, 3, 4, 5]));
    expect(Array.from(h.slice(0, 5))).toEqual([4, 5]);
  });
});

describe('DictationSession', () => {
  it('transcrit chaque segment à la pause, puis assemble le texte final', async () => {
    const engine = new FakeEngine({ script: ['Bonjour.', 'Ouvre le dossier des ventes.'] });
    const { session, segments, states } = collect(engine);

    session.accept(speechFrame());
    session.accept(speechFrame());
    session.accept(silenceFrame()); // pause : premier segment
    await flushMicrotasks();
    expect(segments.map((s) => s.text)).toEqual(['Bonjour.']);

    session.accept(speechFrame());
    const text = await session.stop(); // flush : dernier segment
    expect(text).toBe('Bonjour. Ouvre le dossier des ventes.');
    expect(segments.map((s) => [s.index, s.final])).toEqual([
      [0, true],
      [1, true],
    ]);
    expect(states).toEqual(['listening', 'transcribing', 'idle']);
  });

  it('ajoute 300 ms d’audio avant chaque segment (pré-roll)', async () => {
    const engine = new FakeEngine({ script: ['Lance la VM.'] });
    const { session, segments } = collect(engine);
    for (let i = 0; i < 5; i += 1) session.accept(silenceFrame(0.01 * (i + 1) * 0.1));
    session.accept(speechFrame());
    await session.stop();
    // 3 trames de 100 ms reprises avant le segment, puis la trame de parole.
    expect(engine.received[0]?.length).toBe(4 * VOICE_FRAME_SAMPLES);
    expect(segments[0]?.startMs).toBe(200);
    expect(segments[0]?.endMs).toBe(600);
  });

  it('applique la typographie française seulement aux segments français', async () => {
    const engine = new FakeEngine({
      script: ['Tu peux ouvrir le fichier ?', 'Can you open the file?', 'OK ?'],
    });
    const { session, segments } = collect(engine);
    for (let i = 0; i < 3; i += 1) {
      session.accept(speechFrame());
      session.accept(silenceFrame());
    }
    const text = await session.stop();
    expect(segments.map((s) => s.text)).toEqual([
      `Tu peux ouvrir le fichier${NNBSP}?`,
      'Can you open the file?',
      // Trop court pour trancher : langue du segment précédent (anglais).
      'OK ?',
    ]);
    expect(text).toBe(`Tu peux ouvrir le fichier${NNBSP}? Can you open the file? OK ?`);
  });

  it('ignore les segments vides', async () => {
    const engine = new FakeEngine({ script: ['', 'Bonjour.'] });
    const { session, segments } = collect(engine);
    session.accept(speechFrame());
    session.accept(silenceFrame());
    session.accept(speechFrame());
    expect(await session.stop()).toBe('Bonjour.');
    expect(segments.map((s) => s.index)).toEqual([0]);
  });

  it('annule : rien n’est rendu, la transcription en cours est ignorée', async () => {
    const gate = deferred();
    const engine = new FakeEngine({ script: ['Secret.'], gate: () => gate.promise });
    const { session, segments, states } = collect(engine);
    session.accept(speechFrame());
    session.accept(silenceFrame());
    await flushMicrotasks();
    session.cancel();
    gate.resolve();
    await flushMicrotasks();
    expect(segments).toEqual([]);
    expect(states).toEqual(['listening', 'idle']);
    expect(engine.segmenters[0]?.disposed).toBe(true);
    // Les trames suivantes sont ignorées, et stop échoue.
    session.accept(speechFrame());
    await expect(session.stop()).rejects.toBeInstanceOf(AtelierError);
  });

  it('s’arrête d’elle-même à la durée maximale', async () => {
    const engine = new FakeEngine({ script: ['Long discours.'] });
    const { session, autoStops, states } = collect(engine, 1000);
    for (let i = 0; i < 15; i += 1) session.accept(speechFrame());
    await flushMicrotasks(20);
    expect(autoStops).toEqual(['Long discours.']);
    // Seule la première seconde est transcrite.
    expect(engine.received[0]?.length).toBe(10 * VOICE_FRAME_SAMPLES);
    expect(states).toEqual(['listening', 'transcribing', 'idle']);
    // stop() après l'arrêt automatique rend le même texte.
    expect(await session.stop()).toBe('Long discours.');
    expect(session.active).toBe(false);
  });

  it('libère les tampons après la transcription', async () => {
    const engine = new FakeEngine({ script: ['Bonjour.'] });
    const { session } = collect(engine);
    session.accept(speechFrame());
    await session.stop();
    expect(engine.buffers[0]?.every((v) => v === 0)).toBe(true);
    expect(engine.received[0]?.some((v) => v !== 0)).toBe(true);
  });

  it('signale une entrée muette, puis le retour du signal', () => {
    const engine = new FakeEngine();
    const { session, states } = collect(engine);
    for (let i = 0; i < 10; i += 1) session.accept(zeroFrame());
    expect(states).toEqual(['listening', 'listening:silent_input']);
    session.accept(silenceFrame());
    expect(states).toEqual(['listening', 'listening:silent_input', 'listening']);
    session.cancel();
  });

  it('termine en erreur si le moteur échoue, sans recopier le message natif', async () => {
    const engine = new FakeEngine({ script: ['a', 'b'], failAt: 0 });
    const { session, errors } = collect(engine);
    session.accept(speechFrame());
    session.accept(silenceFrame());
    session.accept(speechFrame());
    const error = await session.stop().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtelierError);
    expect((error as AtelierError).code).toBe('voice/engine_failed');
    expect((error as AtelierError).message).not.toContain('natif');
    expect(errors).toHaveLength(1);
    // Une seule transcription : la suivante est abandonnée.
    expect(engine.received).toHaveLength(1);
  });
});
