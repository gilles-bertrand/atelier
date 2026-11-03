import { describe, expect, it } from 'vitest';
import { AtelierError, VOICE_FRAME_SAMPLES, type TranscriptSegment } from '@atelier/shared';
import { AudioHistory, DictationSession, type DictationOptions } from '../src/dictation.js';
import { NNBSP } from '../src/typography.js';
import {
  FakeEngine,
  deferred,
  flushMicrotasks,
  silenceFrame,
  speechFrame,
  zeroFrame,
} from './fakes.js';

function collect(
  engine: FakeEngine,
  maxDurationMs?: number,
  finalBlockMaxMs?: number,
  extra: Partial<DictationOptions> = {},
) {
  const segments: TranscriptSegment[] = [];
  const states: string[] = [];
  const autoStops: string[] = [];
  const errors: AtelierError[] = [];
  const session = new DictationSession(
    {
      voiceSessionId: 'v1',
      engine,
      ...(maxDurationMs ? { maxDurationMs } : {}),
      ...(finalBlockMaxMs !== undefined ? { finalBlockMaxMs } : {}),
      ...extra,
    },
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
    const { session, segments, states } = collect(engine, undefined, 0);

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
    const { session, segments } = collect(engine, undefined, 0);
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
    const { session, segments } = collect(engine, undefined, 0);
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
    const { session, segments } = collect(engine, undefined, 0);
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
    // Seule la première seconde est transcrite (d'un bloc : 300 ms de silence après).
    expect(engine.received[0]?.length).toBe(13 * VOICE_FRAME_SAMPLES);
    expect(engine.received[0]?.subarray(10 * VOICE_FRAME_SAMPLES).every((v) => v === 0)).toBe(true);
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

  describe('texte final d’un bloc (#42)', () => {
    it('retranscrit tous les segments d’un bloc à l’arrêt', async () => {
      const engine = new FakeEngine({
        script: ['Liste les actions.', 'Liste les actions, les responsables et les échéances.'],
      });
      const { session, segments } = collect(engine);
      session.accept(speechFrame());
      session.accept(silenceFrame()); // pause : premier segment, transcrit en direct
      await flushMicrotasks();
      expect(segments.map((s) => s.text)).toEqual(['Liste les actions.']);
      session.accept(speechFrame());
      session.accept(speechFrame());
      const text = await session.stop();
      expect(text).toBe('Liste les actions, les responsables et les échéances.');
      // Deux appels : le segment en direct, puis le bloc. Le dernier segment n'est
      // pas transcrit à part.
      expect(engine.received).toHaveLength(2);
      const first = engine.received[0]?.length ?? 0;
      // Bloc : chaque segment suivi de 300 ms de la pause qui l'a fermé, sans audio
      // en double. Segment 1 [0, 1) + pause jusqu'à 4 trames ; segment 2 [2, 4) + 3
      // trames : 7 trames, les 3 dernières en silence (pas encore reçues).
      expect(first).toBe(VOICE_FRAME_SAMPLES);
      expect(engine.received[1]?.length).toBe(7 * VOICE_FRAME_SAMPLES);
      expect(engine.received[1]?.subarray(4 * VOICE_FRAME_SAMPLES).every((v) => v === 0)).toBe(
        true,
      );
      expect(segments).toHaveLength(1);
    });

    it('un seul segment déjà transcrit : son texte sert tel quel, sans bloc', async () => {
      const engine = new FakeEngine({ script: ['Bonjour.', 'jamais lu'] });
      const { session, segments } = collect(engine);
      session.accept(speechFrame());
      session.accept(silenceFrame());
      await flushMicrotasks();
      expect(await session.stop()).toBe('Bonjour.');
      expect(engine.received).toHaveLength(1);
      expect(segments).toHaveLength(1);
    });

    it('applique la typographie française au bloc', async () => {
      const engine = new FakeEngine({ script: ['Tu peux ouvrir le fichier ?'] });
      const { session } = collect(engine);
      session.accept(speechFrame());
      expect(await session.stop()).toBe(`Tu peux ouvrir le fichier${NNBSP}?`);
    });

    it('au-delà de la limite, assemble les segments sans le point des pauses', async () => {
      const engine = new FakeEngine({
        script: ['Liste les actions.', 'les responsables.', 'Merci.'],
      });
      // Limite de 250 ms : le deuxième segment la dépasse.
      const { session } = collect(engine, undefined, 250);
      for (let i = 0; i < 3; i += 1) {
        session.accept(speechFrame());
        session.accept(silenceFrame());
      }
      expect(await session.stop()).toBe('Liste les actions les responsables. Merci.');
      expect(engine.received).toHaveLength(3);
    });

    it('sans vitesse mesurée, assemble les segments (piste 1)', async () => {
      const engine = new FakeEngine({ script: ['Un.', 'deux.'] });
      const { session } = collect(engine);
      session.accept(speechFrame());
      session.accept(silenceFrame()); // en file, pas encore transcrit à l'arrêt
      session.accept(speechFrame());
      expect(await session.stop()).toBe('Un deux.');
      expect(engine.received).toHaveLength(2);
    });

    it('si le bloc échoue, assemble les segments sans erreur', async () => {
      const engine = new FakeEngine({
        script: ['Liste les actions.', 'x', 'les responsables.'],
        failAt: 1,
      });
      const { session, errors } = collect(engine);
      session.accept(speechFrame());
      session.accept(silenceFrame());
      await flushMicrotasks();
      session.accept(speechFrame());
      expect(await session.stop()).toBe('Liste les actions les responsables.');
      expect(errors).toEqual([]);
      // Segment, bloc (échec), puis le dernier segment en repli.
      expect(engine.received).toHaveLength(3);
    });

    it('si le bloc dépasse son délai, assemble les segments', async () => {
      let slow = false;
      const late = deferred();
      const engine = new FakeEngine({
        script: ['Liste les actions.', 'bloc trop tard', 'les responsables.'],
        gate: () => (slow ? ((slow = false), late.promise) : Promise.resolve()),
      });
      const { session } = collect(engine, undefined, undefined, { finalBlockBudgetMs: 20 });
      session.accept(speechFrame());
      session.accept(silenceFrame());
      await flushMicrotasks();
      session.accept(speechFrame());
      slow = true;
      expect(await session.stop()).toBe('Liste les actions les responsables.');
      late.resolve();
      await flushMicrotasks();
      // L'audio du bloc est effacé à la fin du décodage, même tardive.
      expect(engine.buffers.every((b) => b.every((v) => v === 0))).toBe(true);
    });

    it('bloc retenu si la vitesse mesurée tient le délai, refusé sinon', async () => {
      // Segment d'une trame (100 ms) ; bloc de 6 trames (pauses comprises), prévu à
      // 6 × coût × 1,5 : 90 ms pour un moteur rapide (10 ms), 1,8 s pour un lent.
      const cases = [
        {
          costMs: 10,
          script: ['Liste les actions.', 'Liste les actions, les responsables.'],
          text: 'Liste les actions, les responsables.',
          calls: 2,
        },
        {
          costMs: 200,
          script: ['Liste les actions.', 'les responsables.'],
          text: 'Liste les actions les responsables.',
          calls: 2,
        },
      ];
      for (const c of cases) {
        let t = 0;
        const engine = new FakeEngine({
          script: c.script,
          gate: () => {
            t += c.costMs;
            return Promise.resolve();
          },
        });
        const { session } = collect(engine, undefined, undefined, {
          finalBlockBudgetMs: 100,
          now: () => t,
        });
        session.accept(speechFrame());
        session.accept(silenceFrame());
        await flushMicrotasks();
        session.accept(speechFrame());
        expect(await session.stop()).toBe(c.text);
        expect(engine.received).toHaveLength(c.calls);
        // Rapide : le bloc (6 trames, pauses comprises) ; lent : le dernier segment
        // seul, avec ses 2 trames de pré-roll.
        expect(engine.received[1]?.length).toBe((c.costMs === 10 ? 6 : 3) * VOICE_FRAME_SAMPLES);
      }
    });

    it('n’attend pas les segments en file : seul celui en cours finit', async () => {
      const gate = deferred();
      const engine = new FakeEngine({
        script: ['un.', 'Un, deux, trois.'],
        gate: () => gate.promise,
      });
      const { session } = collect(engine);
      session.accept(speechFrame());
      session.accept(silenceFrame());
      await flushMicrotasks(); // premier segment en cours de transcription
      session.accept(speechFrame());
      session.accept(silenceFrame()); // deuxième segment en file
      session.accept(speechFrame());
      const text = session.stop();
      gate.resolve();
      expect(await text).toBe('Un, deux, trois.');
      // Le premier segment était en cours ; le deuxième et le dernier sont repris par le bloc.
      expect(engine.received).toHaveLength(2);
    });

    it('efface l’audio du bloc après la transcription', async () => {
      const engine = new FakeEngine({ script: ['Bonjour.', 'Bonjour, au revoir.'] });
      const { session } = collect(engine);
      session.accept(speechFrame());
      session.accept(silenceFrame());
      await flushMicrotasks();
      session.accept(speechFrame());
      await session.stop();
      expect(engine.buffers.every((b) => b.every((v) => v === 0))).toBe(true);
      expect(engine.received[1]?.some((v) => v !== 0)).toBe(true);
    });

    it('annulée pendant le bloc : rien n’est rendu', async () => {
      const gate = deferred();
      const engine = new FakeEngine({ script: ['Secret.'], gate: () => gate.promise });
      const { session } = collect(engine);
      session.accept(speechFrame());
      const stopped = session.stop().catch((e: unknown) => e);
      await flushMicrotasks();
      session.cancel();
      gate.resolve();
      expect(await stopped).toBeInstanceOf(AtelierError);
    });
  });
});
