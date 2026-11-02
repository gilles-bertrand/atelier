# @atelier/voice

Voix locale d'Atelier ([ADR-004](../../docs/adr/ADR-004-voix.md)). L'audio reste sur le Mac et n'est jamais écrit sur le disque. Ce package contient le catalogue des modèles et leur gestionnaire (lot L1, #27), puis le moteur de reconnaissance et le pipeline de dictée (lot L2, #28).

## Catalogue (`src/catalog.ts`)

| Modèle                                   | Rôle           | Source                                         | Licence   |
| ---------------------------------------- | -------------- | ---------------------------------------------- | --------- |
| `silero-vad`                             | détection      | embarqué (`Contents/Resources/voice/`)         | MIT       |
| `parakeet-tdt-0.6b-v3-int8` (par défaut) | reconnaissance | téléchargé (464,6 Mo, releases de sherpa-onnx) | CC-BY-4.0 |

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

### Confidentialité (D9)

- Aucun fichier audio écrit. Chaque tampon de segment est mis à zéro après sa transcription ; l'historique du pré-roll (30 s au plus, en mémoire) est effacé à la fin de la session.
- Aucun transcript dans les journaux ni dans les erreurs : les erreurs natives sont remplacées par un message français générique, les rejets de protocole ne donnent que le chemin du champ.

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
```

Les archives de test sont fabriquées en mémoire (`test/helpers/tar.ts`), y compris celles que `tar` refuserait de créer (`../`, liens).

Hors périmètre de L2 : le glossaire (`VoiceSettings.glossary`). Les hotwords de sherpa-onnx exigent `modified_beam_search` et des phrases tokenisées (Parakeet n'a pas de `bpeVocab` dans son archive) : à mesurer avant de l'activer.
