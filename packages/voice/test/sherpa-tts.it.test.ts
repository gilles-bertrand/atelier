/**
 * Test réel de la synthèse (ADR-004 §8, L7) : Supertonic 3 int8, voix M4,
 * 8 étapes, 2 threads CPU, à travers `AgentSpeech` (découpage, filtre,
 * première phrase coupée à la virgule).
 *
 * Mesure le délai du premier son, à comparer à D7 (médiane 0,55 s, mesurée à
 * 0,54 s en S2), et note la charge de la machine. Le contrôle d'intelligibilité
 * relit l'audio avec Parakeet v3 quand le modèle est présent.
 *
 * Skippé hors macOS arm64 ou sans `ATELIER_VOICE_IT=1`. Modèles :
 * - `ATELIER_VOICE_TTS_DIR` (par défaut le cache du spike S2,
 *   `~/.cache/atelier-voice-spike/tts/models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11`) ;
 * - `ATELIER_VOICE_MODELS_DIR` pour Parakeet (cache du spike S1).
 *
 * `ATELIER_VOICE_IT_REPORT=<fichier>` écrit les mesures en JSON (sans audio).
 * Aucun audio n'est écrit sur le disque.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOICE_SAMPLE_RATE, type VoiceAudioOut } from '@atelier/shared';
import type * as Sherpa from 'sherpa-onnx-node';
import { engineLoadConfigSchema, ttsLoadConfigSchema } from '../src/protocol.js';
import { createSherpaEngine } from '../src/sherpa.js';
import { createSherpaSynthesizer } from '../src/sherpa-tts.js';
import { AgentSpeech } from '../src/speech.js';

const enabled =
  process.platform === 'darwin' && process.arch === 'arm64' && process.env.ATELIER_VOICE_IT === '1';

const ttsDir =
  process.env.ATELIER_VOICE_TTS_DIR ??
  join(
    homedir(),
    '.cache/atelier-voice-spike/tts/models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
  );
const sttModelsDir =
  process.env.ATELIER_VOICE_MODELS_DIR ?? join(homedir(), '.cache/atelier-voice-spike/models');
const parakeetDir = join(sttModelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');

/**
 * Les 10 réponses types de S2, écrites comme l'agent les écrirait (chiffres,
 * montants, heures, markdown, chemin) : le filtre fait partie de la mesure.
 */
const ANSWERS = [
  'Bonjour Gilles ! Que puis-je faire pour toi aujourd’hui ?',
  'Je lis le fichier `/Users/gilles/Documents/ventes.csv`.',
  'J’ai lu le fichier des ventes de mars. Le chiffre d’affaires atteint **42 300 €**, en hausse de 8 %.',
  'C’est fait. J’ai créé le dossier Factures 2026 et j’y ai rangé les 12 PDF.',
  'Tu as 3 réunions demain : à 9h avec Nox, à 14h30 avec l’équipe produit, et à 17h un appel avec Liège.',
  'Je n’ai pas trouvé de contrat signé dans ce dossier. Veux-tu que je cherche aussi dans les courriels archivés ?',
  'Pour continuer, j’ai besoin de ton autorisation. Réponds à l’écran, s’il te plaît.',
  'Le rapport fait 20 pages, je l’ai enregistré dans le fichier synthèse. En bref, le projet est dans les temps, mais le budget dépasse de 5 %.',
  'D’après la météo, il fera 11 °C à Bruxelles cet après-midi, avec des averses vers 16h.',
  'J’ai lancé le script Python dans la machine virtuelle. Les tests passent, sauf un : la connexion à la base PostgreSQL échoue.',
];

interface Measure {
  firstSoundMs: number;
  totalMs: number;
  audioSeconds: number;
  chunks: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Une réponse entière d'un coup, comme une première phrase déjà générée par le LLM. */
function speakAnswer(
  speech: AgentSpeech,
  out: VoiceAudioOut[],
  turnId: string,
  text: string,
): Promise<Measure> {
  return new Promise((resolve) => {
    const start = performance.now();
    let first = -1;
    const before = out.length;
    const timer = setInterval(() => {
      const mine = out.slice(before);
      if (first < 0 && mine.length > 0) first = performance.now() - start;
      const last = mine.at(-1);
      if (last?.final === true) {
        clearInterval(timer);
        const samples = mine.reduce((n, c) => n + c.pcm.length, 0);
        resolve({
          firstSoundMs: Math.round(first),
          totalMs: Math.round(performance.now() - start),
          audioSeconds: samples / last.sampleRate,
          chunks: mine.length,
        });
      }
    }, 1);
    speech.begin(turnId);
    speech.push(turnId, text);
    speech.end(turnId);
  });
}

describe.skipIf(!enabled)('synthèse réelle (Supertonic 3 int8, M4, 8 étapes, CPU)', () => {
  it('premier son et intelligibilité sur les 10 réponses types de S2', async () => {
    const loadStart = performance.now();
    const synth = await createSherpaSynthesizer(
      ttsLoadConfigSchema.parse({ voice: 'supertonic-3-m4', dir: ttsDir }),
    );
    const loadMs = Math.round(performance.now() - loadStart);
    expect(synth.sampleRate).toBe(44_100);
    // Tour à blanc, comme en S2 : écarte le premier appel (allocations, caches).
    await synth.synthesize('Bonjour.', { speed: 1 });

    const out: VoiceAudioOut[] = [];
    const speech = new AgentSpeech({
      voiceSessionId: 'it',
      synthesizer: {
        synthesize: async (text, speed) => ({
          sampleRate: synth.sampleRate,
          pcm: await synth.synthesize(text, { speed }),
        }),
      },
      onAudio: (chunk) => out.push(chunk),
    });
    const load = loadavg()[0] ?? 0;
    const measures: Measure[] = [];
    for (const [i, answer] of ANSWERS.entries()) {
      measures.push(await speakAnswer(speech, out, `t${String(i)}`, answer));
    }

    for (const chunk of out) {
      expect(chunk.pcm.every((v) => Number.isFinite(v))).toBe(true);
    }
    expect(out.map((c) => c.seq)).toEqual(out.map((_c, i) => i));
    expect(out.filter((c) => c.final)).toHaveLength(ANSWERS.length);

    const firstSounds = measures.map((m) => m.firstSoundMs);
    const audio = measures.reduce((s, m) => s + m.audioSeconds, 0);
    const synthMs = measures.reduce((s, m) => s + m.totalMs, 0);
    const report = {
      model: 'supertonic-3-tts-int8, M4, 8 étapes, 2 threads CPU',
      loadMs,
      firstSoundMedianMs: median(firstSounds),
      firstSoundMaxMs: Math.max(...firstSounds),
      rtf: Number((synthMs / 1000 / audio).toFixed(3)),
      rssMiB: Math.round(process.memoryUsage().rss / 1_048_576),
      machine: { loadavg1: Number(load.toFixed(1)), cores: cpus().length },
      measures,
    };
    console.info(JSON.stringify(report));
    if (process.env.ATELIER_VOICE_IT_REPORT) {
      writeFileSync(process.env.ATELIER_VOICE_IT_REPORT, JSON.stringify(report, null, 2));
    }
    // D7 vise 0,55 s en médiane ; marge pour une machine chargée (S2 : 0,70 s non coupé).
    expect(report.firstSoundMedianMs).toBeLessThan(1_500);

    // Intelligibilité : Parakeet relit la première et la deuxième réponse.
    if (!existsSync(join(parakeetDir, 'encoder.int8.onnx'))) return;
    const engine = await createSherpaEngine(
      engineLoadConfigSchema.parse({
        vadModel: join(sttModelsDir, 'silero_vad.onnx'),
        stt: { modelId: 'parakeet-tdt-0.6b-v3-int8', dir: parakeetDir },
      }),
    );
    const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as typeof Sherpa;
    const transcribe = async (turnId: string): Promise<string> => {
      const parts = out.filter((c) => c.turnId === turnId);
      const pcm = new Float32Array(parts.reduce((n, c) => n + c.pcm.length, 0));
      let o = 0;
      for (const c of parts) {
        pcm.set(c.pcm, o);
        o += c.pcm.length;
      }
      const at16k = new sherpa.LinearResampler(synth.sampleRate, VOICE_SAMPLE_RATE).flush(pcm);
      return (await engine.transcribe(at16k)).text.toLowerCase();
    };
    try {
      // Les noms propres varient d'un tirage à l'autre (« Gilles », « Jill ») : S2.
      expect(await transcribe('t0')).toMatch(/que puis-je faire/);
      // Le nom du fichier est dit (« vente.csv », « vente.sv » selon le tirage),
      // le chemin complet jamais.
      const file = await transcribe('t1');
      expect(file).toMatch(/fichier vente/);
      expect(file).not.toMatch(/users|documents/);
    } finally {
      engine.dispose();
    }
  }, 300_000);
});
