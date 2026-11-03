// Spike S2 (#32) : synthèse des phrases types avec une voix, mesures CPU.
// Usage : node synth.cjs <lang fr|nl> <voiceId> <outDir> [threads]
// Tout est local : modèles dans ~/.cache/atelier-voice-spike/tts/models.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createRequire } = require('node:module');

const repo = path.resolve(__dirname, '../..');
const sherpa = createRequire(path.join(repo, 'packages/voice/package.json'))('sherpa-onnx-node');
const CACHE = path.join(os.homedir(), '.cache/atelier-voice-spike/tts');
const M = path.join(CACHE, 'models');

const [lang, voiceId, outDir, threadsArg] = process.argv.slice(2);
const numThreads = Number(threadsArg ?? 2);
const phrases = JSON.parse(fs.readFileSync(path.join(__dirname, 'phrases.json'), 'utf8'))[lang];

function phonemizer() {
  return createRequire(path.join(CACHE, 'node/package.json'))('piper-phonemize-node');
}

const ST = path.join(M, 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11');
const STYLES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];

function voiceConfig(id) {
  if (id.startsWith('supertonic-')) {
    const sid = STYLES.indexOf(id.slice('supertonic-'.length));
    if (sid < 0) throw new Error(`style inconnu : ${id}`);
    return {
      model: {
        supertonic: {
          durationPredictor: `${ST}/duration_predictor.int8.onnx`,
          textEncoder: `${ST}/text_encoder.int8.onnx`,
          vectorEstimator: `${ST}/vector_estimator.int8.onnx`,
          vocoder: `${ST}/vocoder.int8.onnx`,
          ttsJson: `${ST}/tts.json`,
          unicodeIndexer: `${ST}/unicode_indexer.bin`,
          voiceStyle: `${ST}/voice.bin`,
        },
      },
      gen: { sid, speed: 1.0, numSteps: Number(process.env.STEPS ?? 8), extra: { lang } },
    };
  }
  if (id === 'kokoro-ff_siwis') {
    const K = path.join(M, 'kokoro-int8-multi-lang-v1_0');
    return {
      model: { kokoro: { model: `${K}/model.int8.onnx`, voices: `${K}/voices.bin`, tokens: `${K}/tokens.txt` } },
      gen: { sid: 30, speed: 1.0, silenceScale: 0.2 },
      phonemize: 'fr',
    };
  }
  const piper = {
    'piper-tom': ['vits-piper-fr_FR-tom-medium', 'fr_FR-tom-medium.onnx', 'fr'],
    'piper-rdh': ['vits-piper-nl_BE-rdh-medium', 'nl_BE-rdh-medium.onnx', 'nl'],
    'piper-alex': ['vits-piper-nl_NL-alex-medium', 'nl_NL-alex-medium.onnx', 'nl'],
  }[id];
  if (!piper) throw new Error(`voix inconnue : ${id}`);
  const d = path.join(M, piper[0]);
  return {
    model: { vits: { model: `${d}/${piper[1]}`, tokens: `${d}/tokens.txt` } },
    gen: { sid: 0, speed: 1.0, silenceScale: 0.2 },
    phonemize: piper[2],
    usePhonemesOnly: true,
  };
}

async function main() {
  const cfg = voiceConfig(voiceId);
  const dir = path.join(outDir, voiceId);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  const tts = new sherpa.OfflineTts({
    model: { ...cfg.model, numThreads, provider: 'cpu', debug: false },
    maxNumSentences: 1,
  });
  const loadMs = performance.now() - t0;
  const pp = cfg.phonemize ? phonemizer() : null;
  const results = [];
  // Un tour à blanc pour écarter le premier appel (allocation, caches).
  await tts.generateAsync({ text: 'Bonjour.', generationConfig: new sherpa.GenerationConfig(genFor(cfg, pp, lang === 'nl' ? 'Hallo.' : 'Bonjour.')) });
  // Comme le main en phase 2 (D7) : découpage en phrases, synthèse phrase
  // par phrase. Premier son = synthèse de la première phrase.
  const gap = new Float32Array(Math.round(0.25 * tts.sampleRate));
  for (let i = 0; i < phrases.length; i++) {
    const sentences = splitSentences(phrases[i]);
    const parts = [];
    let firstSoundMs = null;
    const start = performance.now();
    for (const sentence of sentences) {
      const audio = await tts.generateAsync({
        text: cfg.usePhonemesOnly ? '' : sentence,
        generationConfig: new sherpa.GenerationConfig(genFor(cfg, pp, sentence)),
      });
      if (firstSoundMs === null) firstSoundMs = performance.now() - start;
      if (parts.length > 0) parts.push(gap);
      parts.push(audio.samples);
    }
    const genMs = performance.now() - start;
    const samples = concat(parts);
    const dur = samples.length / tts.sampleRate;
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}.wav`);
    sherpa.writeWave(file, { samples, sampleRate: tts.sampleRate });
    results.push({ i: i + 1, sentences: sentences.length, firstSoundMs: Math.round(firstSoundMs), genMs: Math.round(genMs), audioS: +dur.toFixed(2), rtf: +(genMs / 1000 / dur).toFixed(3) });
  }
  const summary = {
    voiceId, lang, numThreads, sampleRate: tts.sampleRate, loadMs: Math.round(loadMs),
    rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    results,
  };
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(summary, null, 2));
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(`${voiceId} load=${summary.loadMs}ms rss=${summary.rssMiB}MiB firstSound(med)=${med(results.map((r) => r.firstSoundMs))}ms max=${Math.max(...results.map((r) => r.firstSoundMs))}ms rtf(med)=${med(results.map((r) => r.rtf))}`);
}

function splitSentences(text) {
  return text.split(/(?<=[.!?…])\s+/u).map((t) => t.trim()).filter(Boolean);
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function genFor(cfg, pp, text) {
  if (!pp) return cfg.gen;
  const phonemeCodepoints = pp.phonemize(text, cfg.phonemize).filter((s) => s.length > 0);
  return { ...cfg.gen, phonemeCodepoints };
}

main().catch((e) => { console.error(e); process.exit(1); });
