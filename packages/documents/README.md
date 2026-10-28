# @atelier/documents

Lecture multi-format et vision pour l'agent (brief §2bis) : `read_file`, `look_at`, cache des extractions et import des pièces jointes.

## Intégration

```ts
import { createDefaultRegistry, createLlmModels } from '@atelier/agent-core';
import { createDocumentTools, createVisionAnalyzer, importAttachment } from '@atelier/documents';

const models = createLlmModels({ baseUrl, model, token, thinking });
// Vision : modèle principal (multimodal) par défaut ; `fastModel` évite le thinking.
// Modèle vision séparé (Réglages) : createLlmModels({ …, model: settings.visionModel }).model
const vision = createVisionAnalyzer({ model: models.fastModel });

// `read_file` de documents remplace le read_file texte provisoire d'agent-core.
const registry = createDefaultRegistry([...createDocumentTools({ vision }), ...webTools]);
```

Sans `vision`, les images et les pages scannées sont signalées au modèle sans transcription (message clair, pas d'exception). La VM (`ToolExecutionContext.sandbox`) n'est nécessaire que pour rendre les pages PDF en image.

### Glisser-déposer

```ts
const { relativePath } = await importAttachment(droppedHostPath, workspace);
// → ".atelier/uploads/facture.pdf" : à mentionner au modèle dans le message utilisateur.
```

Copie dans `<dossier>/.atelier/uploads/` (jamais d'écrasement : « facture (2).pdf » ; un fichier identique déjà importé est réutilisé), nom assaini, 200 Mo max (`documents/too_large`).

## `read_file({ path, offset?, limit?, pages? })`

| Type (magic bytes, puis extension)      | Traitement                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| texte, code, csv, json…                 | lignes numérotées, `offset`/`limit`, 2000 lignes et 100 000 caractères max ; UTF-8, UTF-16 (BOM), sinon latin-1 (windows-1252) signalé ; 20 Mo max |
| PDF                                     | texte par page (unpdf, côté hôte), `--- page N ---`, nombre total de pages, `pages: "1-10,15"` (20 max par appel ; défaut : les 20 premières)      |
| page PDF sans texte (< 30 car.)         | rendu PNG par `pdftoppm` **dans la VM** (`.atelier/cache/pages/`), puis transcription par le modèle vision ; 10 pages scannées max par appel       |
| png, jpg, webp, gif, heic (+avif, tiff) | orientation EXIF, réduction à 1568 px (sharp ; HEIC décodé par heic-convert), description + transcription par le modèle vision                     |
| docx                                    | mammoth → markdown (titres, gras, listes, tableaux) ; images remplacées par `[image]`                                                              |
| xlsx                                    | exceljs → une table markdown par feuille (dimensions, 200 lignes et 50 colonnes max, résultat des formules)                                        |
| autre binaire                           | refus `ok: false` avec le type détecté (ex. « ELF (application/x-elf) », « Word 97-2003 (.doc) »)                                                  |

## `look_at({ path, question, page? })`

Envoie l'image (ou la page PDF rendue dans la VM) au modèle vision avec la question et renvoie la réponse texte seule.

## Vision

`createVisionAnalyzer({ model, maxOutputTokens?, timeoutMs?, providerOptions? })` : un appel `generateText` isolé (consignes `VISION_INSTRUCTIONS` + texte + part `file` image), sans l'historique du chat ; seul `result.text` est renvoyé. Le texte de l'image est traité comme de la donnée, jamais comme des instructions. N'importe quel objet `VisionAnalyzer { id, analyze() }` peut être injecté.

## Cache

`<dossier>/.atelier/cache/<sha256>.txt`, clé = SHA-256 du fichier + paramètres (type d'extraction, page, question, identifiant du modèle vision). Sont mis en cache : transcriptions et descriptions vision, réponses de `look_at`, conversions docx/xlsx. Écriture atomique, au mieux (une erreur de cache n'empêche jamais la réponse). `createDocumentTools({ cache: false })` le désactive.

## Sécurité

- Tous les chemins passent par `resolveWorkspacePath` d'agent-core (symlinks compris), y compris le cache, les rendus et les pièces jointes ; un `.atelier` remplacé par un lien sortant est ignoré (cache) ou refusé (uploads).
- Lecture finale en `O_NOFOLLOW` : un lien posé entre la vérification et la lecture est refusé.
- Les PDF scannés sont rendus dans la VM (poppler n'est jamais exécuté côté hôte) ; l'image produite est relue après re-vérification du chemin.
- sharp : `limitInputPixels` (100 Mpx) contre les bombes de décompression.

## Tests

```bash
pnpm --filter @atelier/documents test       # fixtures + MockLanguageModelV4, VM simulée
pnpm --filter @atelier/documents fixtures   # régénère test/fixtures (macOS : sips, zip)
# Vision réelle (Ollama) :
ATELIER_DOCUMENTS_IT=1 ATELIER_LLM_URL=http://localhost:11434 ATELIER_LLM_MODEL=qwen3.5:9b \
  pnpm --filter @atelier/documents test
```

## Packaging (UI / Lead)

`sharp`, `unpdf`, `exceljs`, `mammoth`, `heic-convert` et `file-type` doivent rester externes au bundle du main (`externalizeDepsPlugin`) ; `sharp` charge `@img/sharp-darwin-arm64` + `@img/sharp-libvips-darwin-arm64` : à mettre dans `asarUnpack`. Aucune entrée `allowBuilds` n'est nécessaire (sharp 0.35 n'a plus de script d'installation).
