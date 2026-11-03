// Spike S2 (#32) : intelligibilité de chaque voix, mesurée par Parakeet v3
// (le modèle de dictée retenu) sur les WAV produits par synth.cjs.
// Les nombres écrits en chiffres par Parakeet sont remis en lettres avant le
// calcul (fr-numbers.cjs) ; c'est un indicateur relatif, pas une note de qualité.
// Usage : node intelligibility.cjs <lang> <outDir/lang>
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createRequire } = require('node:module');
const { wer } = require('./wer.cjs');
const { spellNumbersFr } = require('./fr-numbers.cjs');

const repo = path.resolve(__dirname, '../..');
const sherpa = createRequire(path.join(repo, 'packages/voice/package.json'))('sherpa-onnx-node');
const P = path.join(os.homedir(), '.cache/atelier-voice-spike/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
const [lang, root] = process.argv.slice(2);
const phrases = JSON.parse(fs.readFileSync(path.join(__dirname, 'phrases.json'), 'utf8'))[lang];

(async () => {
  const rec = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: `${P}/encoder.int8.onnx`, decoder: `${P}/decoder.int8.onnx`, joiner: `${P}/joiner.int8.onnx` },
      tokens: `${P}/tokens.txt`, modelType: 'nemo_transducer', numThreads: 4, provider: 'cpu',
    },
  });
  const voices = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'metrics.json')));
  const table = [];
  for (const v of voices) {
    let errors = 0, words = 0;
    const hyps = [];
    for (let i = 0; i < phrases.length; i++) {
      const w = sherpa.readWave(path.join(root, v, `${String(i + 1).padStart(2, '0')}.wav`));
      const s = rec.createStream();
      s.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples });
      const text = (await rec.decodeAsync(s)).text;
      const r = wer(phrases[i], lang === 'fr' ? spellNumbersFr(text) : text);
      errors += r.errors; words += r.words;
      hyps.push({ i: i + 1, wer: +(r.errors / r.words).toFixed(3), text });
    }
    fs.writeFileSync(path.join(root, v, 'asr.json'), JSON.stringify(hyps, null, 2));
    table.push({ voice: v, wer: +(100 * errors / words).toFixed(1) });
  }
  table.sort((a, b) => a.wer - b.wer);
  for (const t of table) console.log(`${t.voice.padEnd(22)} WER ${t.wer} %`);
})();
