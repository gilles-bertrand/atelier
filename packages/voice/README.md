# @atelier/voice

Voix locale d'Atelier ([ADR-004](../../docs/adr/ADR-004-voix.md)). Ce package contient, pour l'instant (lot L1), le catalogue des modèles et leur gestionnaire. Le moteur de reconnaissance (sherpa-onnx dans un `utilityProcess`) arrive avec L2.

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

## Tests

```bash
pnpm --filter @atelier/voice test
# Import de la vraie archive Parakeet (skippé par défaut) :
ATELIER_VOICE_IT=1 ATELIER_VOICE_PARAKEET_ARCHIVE=/chemin/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 \
  pnpm --filter @atelier/voice test
```

Les archives de test sont fabriquées en mémoire (`test/helpers/tar.ts`), y compris celles que `tar` refuserait de créer (`../`, liens).
