# Spike S2 (#32) : écoute des voix françaises

Code jetable, gardé sur la branche `spike/voice-tts-fr`. Seuls les résultats entrent dans `main` (ADR-004, §3.5 et D4).

Tout tourne en local. Modèles, sons et clés de l'écoute à l'aveugle sont dans `~/.cache/atelier-voice-spike/tts` (hors dépôt).

| Script                   | Rôle                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `phrases.json`           | 10 réponses types en français, 5 en néerlandais                                            |
| `synth.cjs`              | synthèse phrase par phrase (comme D7), mesures : chargement, premier son, RTF, mémoire     |
| `intelligibility.cjs`    | WER de Parakeet v3 sur les WAV produits (nombres remis en lettres par `fr-numbers.cjs`)    |
| `blind-pack.cjs`         | paquet d'écoute anonymisé (lettres tirées au hasard, volume égalisé), clé rangée à part    |

```bash
node spike/voice-tts/synth.cjs fr supertonic-F3 ~/.cache/atelier-voice-spike/tts/out/fr 2
STEPS=4 node spike/voice-tts/synth.cjs fr supertonic-F3 ~/.cache/atelier-voice-spike/tts/bench/t2-s4 2
node spike/voice-tts/intelligibility.cjs fr ~/.cache/atelier-voice-spike/tts/out/fr
```

Piper et Kokoro demandent `piper-phonemize-node` (GPL-3.0, espeak-ng), installé dans `~/.cache/atelier-voice-spike/tts/node` : sherpa-onnx 2.x n'embarque plus espeak-ng.
