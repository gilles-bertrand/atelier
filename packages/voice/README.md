# @atelier/voice

Voix locale d'Atelier ([ADR-004](../../docs/adr/ADR-004-voix.md)). L'audio reste sur le Mac et n'est jamais écrit sur le disque. Ce package contient le catalogue des modèles et leur gestionnaire (lot L1, #27), le moteur de reconnaissance et le pipeline de dictée (lot L2, #28), puis la synthèse vocale et le filtre « prononçable » (lot L7, #35).

## Catalogue (`src/catalog.ts`)

| Modèle                                   | Rôle           | Source                                         | Licence    |
| ---------------------------------------- | -------------- | ---------------------------------------------- | ---------- |
| `silero-vad`                             | détection      | embarqué (`Contents/Resources/voice/`)         | MIT        |
| `parakeet-tdt-0.6b-v3-int8` (par défaut) | reconnaissance | téléchargé (464,6 Mo, releases de sherpa-onnx) | CC-BY-4.0  |
| `supertonic-3-tts-int8`                  | synthèse (L7)  | téléchargé (122,8 Mo, release `tts-models`)    | OpenRAIL-M |

Voix de synthèse (`TTS_VOICES`, réglage `ttsVoice`) : `supertonic-3-m4` (`DEFAULT_TTS_VOICE`), style M4 (identifiant 8 dans `voice.bin`), français, 8 étapes. Le repli à 5 étapes (`SUPERTONIC_FALLBACK_NUM_STEPS`) est une constante interne, pas un réglage : il ne sert que si L11 mesure un budget de latence dépassé. Supertonic est dérivé de `Supertone/supertonic-3` à la révision `3cadd1ee…` (champ `upstream`, épinglé comme l'empreinte). Aucun phonémiseur : ni espeak-ng ni `piper-phonemize-node` (GPL).

Chaque entrée épingle version, URL, **SHA-256**, taille et liste exacte des fichiers. L'empreinte n'est jamais lue sur le serveur de téléchargement (même règle que `scripts/fetch-lima.ts`).

**Monter de version** : télécharger l'archive de la release officielle, `shasum -a 256 <archive>`, relever la taille (`stat -f %z`) et la liste (`tar -tvf`), puis changer `version`, `sha256`, `bytes` et `files`. Les utilisateurs verront une mise à jour proposée (`pendingUpdates()`), jamais appliquée en silence.

`voiceModelLicenses()` fournit les attributions pour « À propos › Licences ».

## `VoiceModelManager` (`src/manager.ts`)

```ts
const models = new VoiceModelManager({
  rootDir: voiceModelsDir(app.getPath('userData')), // …/Atelier/models/voice
  bundledDir: join(process.resourcesPath, 'voice'),
  onModelChange: (info) => send('voice:model', info),
});
await models.init(); // nettoie les installations interrompues
await models.install('parakeet-tdt-0.6b-v3-int8', { sourceUrl: settings.voice?.modelSourceUrl });
await models.importArchive('parakeet-tdt-0.6b-v3-int8', '/chemin/archive.tar.bz2');
const { files } = await models.resolve('parakeet-tdt-0.6b-v3-int8'); // chemins pour le moteur
```

Installation atomique dans `<id>@<version>/` :

1. place disque (`statfs`, injectable) ;
2. téléchargement dans `.downloads/<id>@<version>.partial`, reprise par `Range` ;
3. SHA-256 du catalogue ;
4. liste `tar -tf` contrôlée (aucun chemin absolu ni `..`, rien d'inattendu), puis extraction par `tar` **sans shell** dans `.staging-*` ;
5. arbre extrait contrôlé : fichiers ordinaires seulement, liste et tailles exactes ;
6. renommage en `<id>@<version>/`, puis `manifest.json` (écrit en dernier, par renommage).

Un modèle n'est installé que si son manifeste correspond au catalogue et ses fichiers ont la bonne taille. `init()` supprime les restes d'un crash ; le `.partial` est gardé pour la reprise.

**Erreurs** (`AtelierError`) : `voice/model_invalid` (empreinte, contenu, taille ; `details.reason`), `voice/download_failed` (`retryable` ; `details.reason` vaut `disk_full` ou `cancelled` dans ces cas), `voice/model_missing` (modèle inconnu ou non installé), `settings/invalid` (miroir hors de la règle de `checkServerUrl`, suppression d'un modèle embarqué).

## Moteur et dictée (L2)

```
main (L3)                                   utilityProcess « voice » (L3 : point d'entrée)
VoiceWorkerSupervisor ── MainToWorker ──▶   runVoiceWorker
  lancement à la demande                      validation Zod de chaque message
  arrêt après idleUnloadMinutes               DictationSession (une à la fois)
  relance après un crash          ◀── WorkerToMain ──  SpeechEngine (sherpa-onnx : Silero + Parakeet)
```

| Fichier                           | Rôle                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine.ts`                   | Interface `SpeechEngine` (découpeur de parole + transcription), locale au package : un moteur serveur ou natif pourra s'y brancher sans toucher à l'UI.    |
| `src/sherpa.ts`                   | Adaptateur sherpa-onnx : Silero VAD, puis Parakeet TDT 0.6B v3 int8 sur le CPU (2 threads, réglages du spike S1). Module natif chargé à la demande.        |
| `src/dictation.ts`                | `DictationSession` : segments transcrits dans l'ordre, pré-roll de 300 ms, assemblage, durée maximale (5 min), annulation, alerte `silent_input`.          |
| `src/typography.ts`               | Langue du texte (mots outils, accents) et typographie française : espace insécable avant `:` et dans `« »`, espace fine insécable avant `; ! ?`.           |
| `src/protocol.ts`                 | Messages main ↔ worker, validés par Zod dans les deux sens. Un message invalide est rejeté avec le chemin du champ fautif, jamais sa valeur.               |
| `src/worker.ts`                   | `runVoiceWorker` : boucle de messages du worker, indépendante d'Electron (port injecté).                                                                   |
| `src/supervisor.ts`               | `VoiceWorkerSupervisor` : côté main, indépendant d'Electron (`spawn` injecté). Une seule session (`voice/busy`), délais de chargement et de transcription. |
| `src/types/sherpa-onnx-node.d.ts` | Déclaration locale de la surface utilisée de `sherpa-onnx-node` (le paquet ne publie pas de `.d.ts`), comme `jsdom.d.ts`.                                  |

### Branchement dans l'app (L3)

```ts
// Point d'entrée du utilityProcess
runVoiceWorker({
  port: {
    postMessage: (m) => process.parentPort.postMessage(m),
    onMessage: (l) => process.parentPort.on('message', (e) => l(e.data)),
  },
  createEngine: (config) => createSherpaEngine(config),
  exit: () => process.exit(0),
});

// Main
const supervisor = new VoiceWorkerSupervisor({
  spawn: () =>
    adaptUtilityProcess(utilityProcess.fork(workerPath, [], { serviceName: 'Atelier Voice' })),
  loadConfig: () => ({ vadModel, stt: { modelId, dir } }), // chemins du gestionnaire de modèles
  idleUnloadMinutes: settings.voice.idleUnloadMinutes,
  onTranscript,
  onSessionState,
  onAutoStop,
  onSessionError,
  onEngineState,
});
```

`sherpa-onnx-node` et `sherpa-onnx-darwin-arm64` restent externes au bundle et dépaquetés de l'asar (ADR-004 D2, L3).

## Synthèse vocale (L7)

```
main (L9)                                                    utilityProcess « voice »
AgentSpeech ── texte en flux ──▶ SpeechChunker (phrases)      runVoiceWorker
   │                              speakableLine (filtre)        file « tts » séparée de la dictée
   └── un morceau à la fois ──▶ VoiceWorkerSupervisor ─ speak ─▶ SpeechSynthesizer (Supertonic 3)
onAudio(VoiceAudioOut) ◀── seq, final ◀────────────── speech (PCM 44,1 kHz) ◀──┘
```

| Fichier                 | Rôle                                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/speakable.ts`      | Filtre « prononçable » en français, fonction pure : retire markdown, tableaux, blocs de code, URL, emoji ; réduit un chemin complet au nom du fichier (« ventes point csv ») ; écrit nombres, montants, dates, heures, ordinaux et unités en lettres. |
| `src/french-numbers.ts` | Nombres en toutes lettres (orthographe traditionnelle, accords de « vingt », « cent », « mille », « million »), ordinaux, dates, heures, accord féminin du « un » final.                                                                              |
| `src/sentences.ts`      | `SpeechChunker` : découpage en phrases au fil du flux, **première phrase coupée à sa première virgule ou à son premier deux-points** (morceau d'au moins 12 caractères, reste aussi long : S2), lignes de code et de tableau jetées.                  |
| `src/speech.ts`         | `AgentSpeech` : un tour à la fois, un morceau synthétisé à la fois, `VoiceAudioOut` dans l'ordre (`seq` sur toute la session, `final` sur le dernier), silences de 120 ms après une virgule et de 250 ms entre deux phrases, `ttsRate` borné.         |
| `src/sherpa-tts.ts`     | Adaptateur sherpa-onnx de Supertonic 3 (CPU, 2 threads, une phrase par génération).                                                                                                                                                                   |

### Branchement dans le main (L9)

```ts
const supervisor = new VoiceWorkerSupervisor({
  // … reconnaissance, comme en L3
  ttsLoadConfig: () => ({ voice: settings.voice.ttsVoice ?? DEFAULT_TTS_VOICE, dir }), // dossier installé du modèle
});
const speech = new AgentSpeech({
  voiceSessionId,
  synthesizer: supervisor, // VoiceWorkerSupervisor implémente SpeechSynthesisPort
  rate: settings.voice.ttsRate,
  onAudio: (chunk) => send('voice:audio-out', chunk),
  onError: (turnId, error) => log('voice: synthèse en échec', { code: error.code }),
});
speech.begin(turnId);
speech.push(turnId, delta); // à chaque morceau de texte de l'agent
speech.end(turnId); // fin du tour : le reste est dit, puis un morceau `final`
speech.interrupt(); // bouton « Interrompre », Stop, fin du mode : aucun morceau final
```

La synthèse se charge à la demande dans le worker déjà lancé pour la reconnaissance (`ensureSpeechLoaded`) : le mode conversation a besoin des deux. Un worker en train de parler n'est pas déchargé pour inactivité ; un crash fait échouer les synthèses en cours, et la voix est rechargée au morceau suivant.

### Confidentialité (D9)

- Aucun fichier audio écrit. Chaque tampon de segment est mis à zéro après sa transcription ; l'historique du pré-roll (30 s au plus, en mémoire) est effacé à la fin de la session.
- Aucun transcript dans les journaux ni dans les erreurs : les erreurs natives sont remplacées par un message français générique, les rejets de protocole ne donnent que le chemin du champ.
- Synthèse : l'audio reste en mémoire (aucun fichier), et le texte de l'agent n'apparaît ni dans les journaux ni dans les erreurs, même quand le moteur natif échoue sur une phrase.

## Tests

```bash
pnpm --filter @atelier/voice test
# Import de la vraie archive Parakeet (skippé par défaut) :
ATELIER_VOICE_IT=1 ATELIER_VOICE_PARAKEET_ARCHIVE=/chemin/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 \
  pnpm --filter @atelier/voice test
# Test réel (macOS arm64) : Parakeet sur 3 WAV (fr, en, de) de l'archive officielle
ATELIER_VOICE_IT=1 pnpm --filter @atelier/voice test
# Modèles ailleurs que dans ~/.cache/atelier-voice-spike/models :
ATELIER_VOICE_IT=1 ATELIER_VOICE_MODELS_DIR=/chemin/models pnpm --filter @atelier/voice test
# Synthèse réelle : délai du premier son sur les 10 réponses types de S2 (rapport JSON sans audio)
ATELIER_VOICE_IT=1 ATELIER_VOICE_TTS_DIR=/chemin/sherpa-onnx-supertonic-3-tts-int8-2026-05-11 \
  ATELIER_VOICE_IT_REPORT=/tmp/tts.json pnpm --filter @atelier/voice test sherpa-tts.it
```

Les archives de test sont fabriquées en mémoire (`test/helpers/tar.ts`), y compris celles que `tar` refuserait de créer (`../`, liens).

Hors périmètre de L2 : le glossaire (`VoiceSettings.glossary`). Les hotwords de sherpa-onnx exigent `modified_beam_search` et des phrases tokenisées (Parakeet n'a pas de `bpeVocab` dans son archive) : à mesurer avant de l'activer.
