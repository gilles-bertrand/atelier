// Spike S2 (#32) : paquet d'écoute à l'aveugle.
// Chaque voix reçoit une lettre tirée au hasard ; volume égalisé (RMS) pour ne
// pas favoriser la voix la plus forte. La clé est écrite à part, à n'ouvrir
// qu'après les notes de Gilles.
// Usage : node blind-pack.cjs <lang> <destDir> <label=wavDir> [label=wavDir...]
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const repo = path.resolve(__dirname, '../..');
const sherpa = createRequire(path.join(repo, 'packages/voice/package.json'))('sherpa-onnx-node');
const [lang, dest, ...pairs] = process.argv.slice(2);
const phrases = JSON.parse(fs.readFileSync(path.join(__dirname, 'phrases.json'), 'utf8'))[lang];

const TARGET_RMS = 0.1; // environ -20 dBFS
function normalize(samples) {
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length) || 1;
  let gain = TARGET_RMS / rms;
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak * gain > 0.97) gain = 0.97 / peak;
  return samples.map((s) => s * gain);
}

const voices = pairs.map((p) => { const [label, dir] = p.split('='); return { label, dir }; });
const letters = 'ABCDEFGH'.slice(0, voices.length).split('');
for (let i = letters.length - 1; i > 0; i--) {
  const j = crypto.randomInt(i + 1);
  [letters[i], letters[j]] = [letters[j], letters[i]];
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
const key = {};
voices.forEach((v, idx) => {
  const letter = letters[idx];
  key[letter] = v.label;
  const vdir = path.join(dest, `Voix ${letter}`);
  fs.mkdirSync(vdir);
  const all = [];
  let rate = 0;
  for (let i = 0; i < phrases.length; i++) {
    const n = String(i + 1).padStart(2, '0');
    const w = sherpa.readWave(path.join(v.dir, `${n}.wav`));
    rate = w.sampleRate;
    const s = normalize(w.samples);
    sherpa.writeWave(path.join(vdir, `phrase-${n}.wav`), { samples: s, sampleRate: rate });
    all.push(s, new Float32Array(Math.round(0.9 * rate)));
  }
  const out = new Float32Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  sherpa.writeWave(path.join(dest, `Voix ${letter} - les ${phrases.length} phrases.wav`), { samples: out, sampleRate: rate });
});
fs.mkdirSync(path.join(path.dirname(dest), '..', '.cles'), { recursive: true });
fs.writeFileSync(path.join(path.dirname(dest), '..', '.cles', `cle-${path.basename(dest)}-NE-PAS-OUVRIR.json`), JSON.stringify(key, null, 2));
fs.writeFileSync(path.join(dest, 'phrases.txt'), phrases.map((p, i) => `${String(i + 1).padStart(2, '0')}. ${p}`).join('\n') + '\n');
console.log(`${dest} : ${Object.keys(key).sort().join(', ')}`);
