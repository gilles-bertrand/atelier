import { describe, expect, it } from 'vitest';
import { AtelierError, type VoiceAudioOut } from '@atelier/shared';
import {
  AgentSpeech,
  CLAUSE_GAP_MS,
  SENTENCE_GAP_MS,
  clampTtsRate,
  type SpeechSynthesisPort,
  type SynthesizedSpeech,
} from '../src/speech.js';
import { flushMicrotasks } from './fakes.js';

const RATE = 1_000;

/** Synthèse contrôlée par le test : chaque appel attend `release`. */
function controlledPort() {
  const calls: { text: string; speed: number; release: () => void; fail: (e: unknown) => void }[] =
    [];
  const port: SpeechSynthesisPort = {
    synthesize: (text, speed) =>
      new Promise<SynthesizedSpeech>((resolve, reject) => {
        calls.push({
          text,
          speed,
          release: () => {
            resolve({ sampleRate: RATE, pcm: new Float32Array(10).fill(1) });
          },
          fail: reject,
        });
      }),
  };
  return { port, calls };
}

function setup(rate?: number) {
  const { port, calls } = controlledPort();
  const out: VoiceAudioOut[] = [];
  const errors: [string, AtelierError][] = [];
  const speech = new AgentSpeech({
    voiceSessionId: 'v1',
    synthesizer: port,
    onAudio: (chunk) => out.push(chunk),
    onError: (turnId, error) => errors.push([turnId, error]),
    ...(rate !== undefined ? { rate } : {}),
  });
  /** Libère les synthèses en attente, une par une, jusqu'à ce que rien ne bouge. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      const next = calls.find((c) => !('done' in c));
      if (next === undefined) break;
      Object.assign(next, { done: true });
      next.release();
      await flushMicrotasks();
    }
  };
  return { speech, calls, out, errors, drain };
}

describe('AgentSpeech', () => {
  it('synthétise phrase par phrase, dans l’ordre, avec seq croissant et un morceau final', async () => {
    const { speech, calls, out, drain } = setup();
    speech.begin('t1');
    speech.push('t1', 'Bonjour Gilles, j’ai trouvé 3 fichiers dans le dossier. ');
    speech.push('t1', 'Le total est de 12 €.');
    // Un seul morceau à la fois : la deuxième phrase attend la première.
    expect(calls.map((c) => c.text)).toEqual(['Bonjour Gilles,']);
    await drain();
    expect(calls.map((c) => c.text)).toEqual([
      'Bonjour Gilles,',
      'j’ai trouvé trois fichiers dans le dossier.',
    ]);
    speech.end('t1');
    await drain();
    expect(calls.map((c) => c.text)).toEqual([
      'Bonjour Gilles,',
      'j’ai trouvé trois fichiers dans le dossier.',
      'Le total est de douze euros.',
    ]);
    expect(out.map((c) => [c.voiceSessionId, c.turnId, c.seq, c.final])).toEqual([
      ['v1', 't1', 0, false],
      ['v1', 't1', 1, false],
      ['v1', 't1', 2, true],
    ]);
    expect(out.every((c) => c.sampleRate === RATE)).toBe(true);
    expect(speech.activeTurnId).toBeUndefined();
  });

  it('insère un court silence après la virgule, un plus long entre deux phrases', async () => {
    const { speech, out, drain } = setup();
    speech.begin('t1');
    speech.push('t1', 'Bonjour Gilles, je regarde les ventes de mars. C’est fait. ');
    speech.end('t1');
    await drain();
    expect(out.map((c) => c.pcm.length)).toEqual([
      10,
      10 + (RATE * CLAUSE_GAP_MS) / 1000,
      10 + (RATE * SENTENCE_GAP_MS) / 1000,
    ]);
    expect(out[1]?.pcm.slice(0, (RATE * CLAUSE_GAP_MS) / 1000).every((v) => v === 0)).toBe(true);
  });

  it('fin du texte pendant la dernière synthèse : ce morceau est le final', async () => {
    const { speech, calls, out, drain } = setup();
    speech.begin('t1');
    speech.push('t1', 'C’est fait.');
    speech.end('t1');
    expect(calls).toHaveLength(1);
    await drain();
    expect(out).toHaveLength(1);
    expect(out[0]?.final).toBe(true);
  });

  it('fin du texte après le dernier morceau : un morceau final vide', async () => {
    const { speech, out, drain } = setup();
    speech.begin('t1');
    speech.push('t1', 'C’est fait. ');
    await drain();
    speech.end('t1');
    expect(out.map((c) => [c.seq, c.final, c.pcm.length])).toEqual([
      [0, false, 10],
      [1, true, 0],
    ]);
  });

  it('un tour sans rien à dire se termine par un morceau final vide', () => {
    const { speech, calls, out } = setup();
    speech.begin('t1');
    speech.push('t1', '```\ncode\n```\n| a | b |\n');
    speech.end('t1');
    expect(calls).toHaveLength(0);
    expect(out).toEqual([
      {
        voiceSessionId: 'v1',
        turnId: 't1',
        seq: 0,
        sampleRate: 44_100,
        pcm: new Float32Array(0),
        final: true,
      },
    ]);
  });

  it('interrompre : file vidée, synthèse en cours ignorée, aucun morceau final', async () => {
    const { speech, calls, out, drain } = setup();
    speech.begin('t1');
    speech.push('t1', 'Première phrase assez longue. Deuxième phrase. Troisième. ');
    speech.interrupt();
    await drain();
    expect(calls).toHaveLength(1);
    expect(out).toEqual([]);
    expect(speech.activeTurnId).toBeUndefined();
    // Un texte tardif du tour interrompu est ignoré.
    speech.push('t1', 'Encore. ');
    speech.end('t1');
    expect(calls).toHaveLength(1);
  });

  it('un nouveau tour interrompt le précédent ; seq continue sur la session', async () => {
    const { speech, out, drain } = setup();
    speech.begin('t1');
    speech.push('t1', 'Un. ');
    await drain();
    speech.push('t1', 'Deux. ');
    speech.begin('t2');
    speech.push('t2', 'Autre réponse.');
    speech.end('t2');
    await drain();
    expect(out.map((c) => [c.turnId, c.seq, c.final])).toEqual([
      ['t1', 0, false],
      ['t2', 1, true],
    ]);
  });

  it('échec de la synthèse : erreur signalée sans le texte, tour terminé', async () => {
    const { speech, calls, out, errors } = setup();
    speech.begin('t1');
    speech.push('t1', 'Phrase secrète du client. Suite. ');
    calls[0]?.fail(new Error('échec natif sur « Phrase secrète du client. »'));
    await flushMicrotasks();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('t1');
    expect(errors[0]?.[1].code).toBe('voice/engine_failed');
    expect(JSON.stringify(errors[0]?.[1].toJSON())).not.toContain('secrète');
    expect(out.map((c) => [c.final, c.pcm.length])).toEqual([[true, 0]]);
    expect(calls).toHaveLength(1);
  });

  it('transmet une AtelierError du moteur telle quelle', async () => {
    const { speech, calls, errors } = setup();
    speech.begin('t1');
    speech.push('t1', 'Bonjour. ');
    calls[0]?.fail(new AtelierError('voice/model_missing', 'Modèle absent.'));
    await flushMicrotasks();
    expect(errors[0]?.[1].code).toBe('voice/model_missing');
  });

  it('applique ttsRate, borné à [0,8 ; 1,3]', async () => {
    const { speech, calls, drain } = setup(1.2);
    speech.begin('t1');
    speech.push('t1', 'Un. ');
    expect(calls[0]?.speed).toBe(1.2);
    speech.setRate(5);
    await drain();
    speech.push('t1', 'Deux. ');
    expect(calls[1]?.speed).toBe(1.3);
    expect(clampTtsRate(0.1)).toBe(0.8);
    expect(clampTtsRate(undefined)).toBe(1);
    expect(clampTtsRate(Number.NaN)).toBe(1);
  });

  it('ignore le texte d’un autre tour', () => {
    const { speech, calls } = setup();
    speech.begin('t1');
    speech.push('t2', 'Pas pour moi. ');
    expect(calls).toHaveLength(0);
  });
});
