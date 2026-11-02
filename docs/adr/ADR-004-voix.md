# ADR-004 : voix locale (dictée, puis conversation vocale)

- **Statut** : accepté. Gilles a validé le 2026-11-01 les recommandations V1 à V4 : dictée, puis conversation ; sherpa-onnx et Parakeet TDT 0.6B v3 ; modèles téléchargés au premier usage. V5 à V7 suivent la recommandation (§2).
- **Ticket** : #23 « Local voice input feature » ; lots : tickets #25 à #39 (§6).
- **Auteur** : architect
- **Impact** : `packages/shared` (Lead), nouveau package `packages/voice`, `packages/agent-core` (phase 2 seulement), `apps/desktop` (main, renderer, packaging), `qa/`, `docs/`
- **Révision du 2026-11-01** : l'audio passe par le main, car `contextBridge` ne transmet pas de `MessagePort` (D2, D3, §5) ; les gestionnaires de permission sont aussi installés en dev (D8) ; S1 mesure aussi le relais audio et, si possible, un Mac de 16 Go.

## 0. En bref

- **Cowork n'a que la dictée.** Son bouton micro transcrit la voix en texte modifiable. Le mode vocal (échange parlé) existe dans Claude Desktop, sur le web et sur mobile, pas dans Cowork. Décision : **phase 1 = dictée** (parité avec Cowork), **phase 2 = mode conversation** (au-delà de Cowork).
- **La RAM n'est pas ce qui décide.** Le profil recommandé occupe environ 1,5 à 2 Go sur les 60 Go. Ce qu'il faut protéger, c'est le LLM local (23 Go résidents, pic mesuré à 38,7 Gio) et le GPU qu'il occupe : **la voix tourne sur le CPU ou le Neural Engine, jamais sur le GPU**.
- **Moteur recommandé : sherpa-onnx** (Apache 2.0, module Node N-API précompilé pour macOS arm64) dans un `utilityProcess` Electron. Il fournit la détection de parole Silero, la reconnaissance **Parakeet TDT 0.6B v3** (5,15 % de WER en français sur FLEURS ; 25 langues européennes, dont le néerlandais et l'anglais) et la synthèse, choisie à l'oreille en phase 2.
- **Modèles téléchargés une fois**, empreintes SHA-256 épinglées dans le code comme pour Lima, rangés dans les données de l'app. Miroir interne et import hors ligne possibles. La mémoire est libérée après inactivité.
- **Rien ne sort du Mac** : aucun service de reconnaissance en ligne, aucun fichier audio écrit. Seul le texte transcrit part au LLM, comme un message tapé.
- **Trois spikes courts d'abord** : le moteur dans l'app signée (S1), l'écoute des voix françaises (S2), l'écho (S3).

## 1. Contexte

**Le ticket** demande un micro pour transcrire et converser, « comme Claude Cowork », en local. Il demande aussi d'évaluer la gestion du modèle vocal et de choisir le modèle le plus adapté à un maximum de 60 Go de RAM.

**Ce que fait Claude.** D'après le centre d'aide d'Anthropic, Cowork et Claude Code proposent la **dictée** : le micro remplit la zone de saisie, l'utilisateur relit, puis envoie. Le **mode vocal** reste propre à Claude Desktop, au web et au mobile.

**État du code (2026-10-31)**

- `setPermissionRequestHandler` refuse toute permission web, micro compris (`apps/desktop/src/main/index.ts`). Il est installé dans `installContentSecurityPolicy`, qui sort tôt en `pnpm dev` (serveur Vite) : en dev, Electron accorde donc toute permission par défaut. Aucun `setPermissionCheckHandler` n'est défini.
- La CSP est stricte (`script-src 'self'`, pas de `media-src`). WebRTC hors proxy est coupé (`disable_non_proxied_udp`), ce qui n'affecte pas `getUserMedia`.
- Les entitlements n'ont pas `com.apple.security.device.audio-input`. L'Info.plist n'a pas de `NSMicrophoneUsageDescription` en français.
- L'IPC n'a que des canaux `invoke` et des événements typés (`IPC_INVOKE_CHANNELS`), sans flux binaire. Le preload est générique : un canal ajouté au contrat y passe sans code nouveau.
- `MessagePort` ne figure pas parmi les types que `contextBridge` sait transmettre. Pour en remettre un à la page, Electron documente un relais par `window.postMessage`.
- Précédents réutilisables :
  - `scripts/fetch-lima.ts`, téléchargement épinglé par SHA-256 dans le code ;
  - l'image de la VM, téléchargée au premier lancement avec une progression ;
  - `sharp`, module natif N-API sorti de l'asar.
- Le modèle de l'agent ne prend pas la voix : `ollama show qwen3.5:35b` liste `completion`, `vision`, `thinking` et `tools`, mais pas `audio`.

**Machine de référence** : MacBook Pro M4 Max, 64 Go, macOS 27. En démo locale, Ollama 0.40.12 sert `atelier` (qwen3.5:35b, runner MLX, nvfp4) avec 23 Go résidents (`ollama ps`). QA a mesuré un pic de 38,7 Gio sur un prompt de 78 000 tokens. La VM Lima a 4 Gio.

**Hypothèse sur les 60 Go** : c'est le budget mémoire total de ce Mac, partagé entre le LLM local, la VM, l'app et la voix. Si les 60 Go visaient plutôt une machine dédiée à la voix, la conclusion change peu (§3.4).

**sherpa-onnx, vérifié le 2026-10-31 sur le paquet publié** :

- `sherpa-onnx-node` 2.0.1 (2026-10-26, Apache 2.0) et son binaire `sherpa-onnx-darwin-arm64` ;
- `sherpa-onnx.node` n'importe que l'API N-API (64 symboles `napi_*`, aucun symbole `node::` ni `v8::`) : rien à recompiler pour l'ABI d'Electron ;
- cible macOS 14.0, comme le brief ;
- embarque `libonnxruntime.dylib`, pour 34 Mo décompressés au total ;
- aucun script d'installation et aucun type TypeScript.

## 2. Décisions validées

Gilles a retenu le 2026-11-01 la recommandation de V1 à V4. V5 à V7 la suivent, faute d'objection. La colonne « Recommandation » fait donc foi.

| #   | Question                                   | Recommandation                                                                                              | Autre option                                                                                                                     |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Périmètre et ordre                         | Phase 1 dictée ; phase 2 conversation, lancée après les spikes S2 et S3                                     | Tout livrer d'un bloc                                                                                                            |
| V2  | Moteur local                               | sherpa-onnx dans un `utilityProcess` : l'app reste en TypeScript                                            | Assistant natif Swift (FluidAudio : Neural Engine, annulation d'écho d'Apple) ; c'est un écart au tableau des décisions de stack |
| V3  | Reconnaissance par défaut                  | Parakeet TDT 0.6B v3, int8                                                                                  | Qwen3-ASR : le 1.7B est plus précis en français, mais pèse 2,4 Gio et tourne 7 fois moins vite                                   |
| V4  | Gestion des modèles                        | Téléchargement au premier usage, SHA-256 épinglé, miroir interne et import hors ligne                       | Modèles embarqués dans le `.dmg`                                                                                                 |
| V5  | Langues                                    | Reconnaissance en français, néerlandais et anglais (détection automatique) ; synthèse française en phase 2  | Français seul                                                                                                                    |
| V6  | Livraison                                  | Un seul responsable (fullstack), comme ADR-003                                                              | Répartition par rôle                                                                                                             |
| V7  | Conversation : interruption et permissions | Parler pendant que l'agent parle vaut Stop (sémantique actuelle) ; aucune permission n'est donnée à la voix | L'interruption ne coupe que la voix, le tour continue                                                                            |

## 3. Analyse

### 3.1 Exigences

|     | Exigence                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Dictée** : bouton micro dans le Composer. Le texte est inséré au curseur et reste modifiable ; il n'est jamais envoyé tout seul. Échap annule.                                                                          |
| F2  | **Conversation** : mode vocal mains libres. L'agent répond à voix haute et garde ses outils et ses permissions ; tout reste écrit dans le fil.                                                                            |
| F3  | **Gestion des modèles** : installer, vérifier, supprimer ; voir la place disque et la mémoire ; fonctionner hors ligne une fois installé.                                                                                 |
| N1  | **Souveraineté** : aucun service de reconnaissance en ligne. Cela exclut l'API Web Speech de Chromium, qui s'appuie sur les services de Google et ne fonctionne pas dans Electron. L'audio n'est jamais écrit sur disque. |
| N2  | **Mémoire** : tenir dans les 60 Go avec le LLM local ; rester compatible avec un Mac client de 16 Go quand le LLM est sur le serveur (brief).                                                                             |
| N3  | **Latence** : en dictée, texte final en 1 s au plus après l'arrêt, pour 15 s de parole. En conversation, 2,5 s au plus entre la fin de la parole et le premier son, en médiane, thinking coupé.                           |
| N4  | **Langues** : français d'abord ; néerlandais et anglais souhaités (Belgique).                                                                                                                                             |
| N5  | **Conventions** : TypeScript strict, I/O injectées, `AtelierError`, Vitest, Electron durci (brief §8).                                                                                                                    |

### 3.2 Où faire tourner la voix

| Option                                 | Principe                                                                         | Pour                                                                                                                                                                                            | Contre                                                                                                                                                                                                                                                   | Verdict                                     |
| -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0. Dictée de macOS                     | Fn Fn dans le Composer, rien à développer                                        | Disponible aujourd'hui                                                                                                                                                                          | Pas de conversation ; ni la langue ni le vocabulaire ne sont pilotables ; traitement géré par Apple, hors de notre contrôle                                                                                                                              | Contournement immédiat, à citer dans l'aide |
| **A. sherpa-onnx en `utilityProcess`** | Module Node N-API : détection de parole, reconnaissance, synthèse                | L'app reste en TypeScript. Un paquet couvre les trois rôles. Calcul sur CPU : aucune concurrence avec le GPU du LLM. Testable avec Vitest. Process isolé, qu'on arrête pour libérer la mémoire. | Module natif à signer et à sortir de l'asar, comme `sharp`. L'annulation d'écho dépend de Chromium (spike S3).                                                                                                                                           | **Recommandé**                              |
| B. Assistant Swift (FluidAudio)        | Binaire embarqué comme `limactl`, protocole JSON sur stdio                       | Neural Engine : le plus rapide et le plus sobre. Annulation d'écho native d'Apple. Pocket TTS français prêt.                                                                                    | Swift dans un monorepo TypeScript, ce qui est un écart au tableau de stack. Compilation et signature en CI. SDK encore en 0.x.                                                                                                                           | Plan B si S1 ou S3 échoue                   |
| C. API d'Apple                         | SpeechAnalyzer (macOS 26+) et voix système                                       | Aucun modèle à gérer                                                                                                                                                                            | 7,61 % de WER en français, le moins bon du comparatif. Pas de néerlandais. Exige macOS 26, alors que le brief vise macOS 14. Boîte noire. Helper Swift.                                                                                                  | Écarté                                      |
| D. Serveur souverain                   | `/v1/audio/transcriptions` et `/v1/audio/speech` derrière Caddy (vLLM, Speaches) | Modèles lourds sur GPU, Mac clients légers, modèles administrés avec le LLM                                                                                                                     | L'audio quitte le Mac. Concurrence avec le LLM sur le GPU du serveur. Plus d'exploitation.                                                                                                                                                               | Phase 3, derrière la même interface         |
| E. Tout confier à Ollama               | Gemma 4 (capacité `audio`) pour transcrire, `/v1/audio/speech` pour parler       | Un seul gestionnaire de modèles                                                                                                                                                                 | Pas d'endpoint de transcription documenté (`input_audio` ne l'est pas). La synthèse d'Ollama (`phonon`) est en anglais seulement. Un second LLM de 7,7 Go en mémoire, qui évincerait le modèle de l'agent sur le serveur (`OLLAMA_MAX_LOADED_MODELS=1`). | Écarté, à surveiller                        |

### 3.3 Modèle de reconnaissance

Les chiffres portent sur FLEURS en français (lecture, parole propre). Ils sont publiés par les auteurs des modèles, ou par un éditeur d'application (Whisper Notes, septembre 2026, MacBook Air M5). S1 les vérifie sur nos propres phrases.

| Modèle                              | Paramètres | WER français            | Vitesse sur Mac                   | Mémoire                                                        | Licence                 | Dans sherpa-onnx                 | Verdict                                                                            |
| ----------------------------------- | ---------- | ----------------------- | --------------------------------- | -------------------------------------------------------------- | ----------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| **Parakeet TDT 0.6B v3** (NVIDIA)   | 0,6 B      | **5,15 %** (MLS 4,97 %) | 75× le temps réel (Neural Engine) | 0,09 Gio sur Neural Engine ; environ 1 Go sur CPU (estimation) | CC-BY-4.0 (attribution) | int8, 464 Mio                    | **Défaut** : 25 langues européennes, ponctuation et majuscules, horodatage par mot |
| Qwen3-ASR 1.7B (Alibaba)            | 1,7 B      | **4,57 %**              | 11×                               | 2,43 Gio                                                       | Apache 2.0              | 0.6B en int8 seulement (837 Mio) | Option « précision » : le 0.6B est mesuré en S1                                    |
| Whisper large-v3-turbo              | 0,8 B      | 5,97 %                  | 3×                                | 1,87 Gio                                                       | MIT                     | oui                              | Écarté : plus lent ; whisper.cpp sur Metal concurrence le LLM                      |
| Apple SpeechAnalyzer                | système    | 7,61 %                  | 31×                               | gérée par macOS                                                | propriétaire            | sans objet                       | Écarté (§3.2 C)                                                                    |
| Voxtral Mini 4B Realtime (Mistral)  | 4 B        | 6,42 % à 480 ms         | streaming natif                   | environ 9 Go en BF16                                           | Apache 2.0              | non (vLLM)                       | Serveur, phase 3                                                                   |
| Nemotron 3.5 ASR streaming (NVIDIA) | 0,6 B      | 9,0 à 11,0 %            | streaming natif                   | environ 0,5 Go                                                 | OpenMDW-1.1             | int8, 453 Mio                    | Écarté : précision en français                                                     |

**Mesures de S1 (#25, 02/11/2026, M4 Max 64 Go, sherpa-onnx-node 2.0.1, CPU 2 threads, int8).** Elles confirment le choix de Parakeet.

| Modèle                   | WER FLEURS (10 phrases) | WER, voix de Gilles (10 phrases métier, micro du Mac) | Décodage de 15 s | Pic mémoire (Node) |
| ------------------------ | ----------------------- | ----------------------------------------------------- | ---------------- | ------------------ |
| **Parakeet TDT 0.6B v3** | **2,5 %**               | **13,2 %** (19,4 % avec les débuts de prise coupés)   | **300 à 470 ms** | 2,3 Go             |
| Qwen3-ASR 0.6B           | 8,9 %                   | 25,0 % (26,5 %)                                       | environ 1,9 s    | 4,0 Go             |

- **Qwen3-ASR 0.6B est écarté** : moins précis, environ 3 fois plus lent, et il invente parfois du texte (« 嗯 » sur un « euh », « en Irlande » pour « en néerlandais »).
- **CoreML est écarté** : pas plus rapide que le CPU (RTF 0,047 contre 0,031), même charge CPU, et pic RSS de 5,4 Go. Le provider reste `cpu`.
- **Erreurs restantes** : surtout les noms propres et les marques (Ollama, Qwen, Triptyk, Gembloux, Nox Law). Les hotwords de sherpa-onnx ou un glossaire de l'utilisateur sont à prévoir en L2.
- **Début de prise perdu** : 0,55 à 0,98 s s'écoulent entre le clic et la première trame audio (getUserMedia, AudioContext, worklet). C'est la première cause d'erreur sur la voix de Gilles. La dictée doit ouvrir le micro avant de signaler qu'elle écoute. Garder environ 0,3 s d'audio avant chaque segment du VAD récupère aussi les attaques coupées.
- **Micro muet** : une prise a reçu des trames entièrement nulles pendant 10 min, sans que rien ne le signale. La capture surveille `mute` et `ended` sur la piste, ainsi que les trames nulles, et prévient l'utilisateur.

**Pourquoi pas un modèle en streaming pour la dictée ?** Parakeet transcrit chaque segment découpé par le détecteur de parole en quelques centaines de millisecondes. Le texte apparaît donc à chaque pause, sans la perte de précision des modèles en streaming (9 à 11 % pour Nemotron, 6,4 % pour Voxtral à 480 ms).

### 3.4 Budget mémoire (60 Go)

| Poste                                                                        | Résident            | Pic               | Origine                                                                    |
| ---------------------------------------------------------------------------- | ------------------- | ----------------- | -------------------------------------------------------------------------- |
| macOS et applications courantes                                              | environ 8 Go        | environ 10 Go     | estimation                                                                 |
| Ollama `atelier` (qwen3.5:35b, MLX nvfp4, contexte 32k)                      | 23 Go               | 38,7 Gio          | `ollama ps` ; QA du 29/10 (prompt de 78k, avant le budget de contexte #40) |
| VM Lima                                                                      | 4 Gio               | 4 Gio             | réglage par défaut                                                         |
| Atelier (main et renderer)                                                   | environ 1 Go        | environ 1,5 Go    | estimation                                                                 |
| **Sous-total sans la voix**                                                  | **environ 36 Go**   | **environ 54 Go** |                                                                            |
| Voix, profil recommandé (Silero, Parakeet v3 int8, synthèse d'environ 100 M) | 1 à 1,5 Go          | environ 2 Go      | reconnaissance mesurée en S1 (voir ci-dessous) ; synthèse estimée          |
| **Total**                                                                    | **environ 37,5 Go** | **environ 56 Go** | sous les 60 Go                                                             |

- **Mesures de S1 pour la reconnaissance** (`utilityProcess` de l'app ad hoc) :
  - empreinte physique du worker : 1,28 Go ; RSS de 1,30 Go une fois chargé, puis de 1,37 à 1,50 Go après 10 prises. Il gagne 30 à 100 Mo par session, d'où le déchargement après inactivité (D5) ;
  - lancement du processus : 70 à 180 ms ; chargement des modèles : 750 à 1 030 ms ;
  - qwen3.5:35b pendant la dictée : aucune perte de débit au rythme de la parole (111,7 tok/s contre 111,6 seul), −2,4 % en décodage continu ;
  - relais renderer → main → worker : p95 de 0,4 à 0,7 ms, au repos comme pendant un tour de l'agent, sans trame perdue. Le relais par le main suffit, `MessagePort` reste une optimisation. L'horodatage aller simple souffre d'un décalage d'horloge entre processus qui a atteint 12 ms ; L0 mesurera en aller-retour.
- **Non mesuré en S1** : pas de Mac de 16 Go disponible.
- **Profil « qualité »** (Qwen3-ASR 1.7B et Qwen3-TTS 1.7B via MLX) : 6 à 7 Go de plus, soit un pic au-delà de 60 Go. Ces modèles tournent en plus sur le GPU et ralentissent le LLM. Leur place est sur le serveur (option D).
- **Gros modèles** (Voxtral Small 24B, Nemotron 3.5 Transcribe 30B-A4B ; 48 à 60 Go en BF16) : ils ne tiennent qu'en déchargeant le modèle de l'agent. Écartés sur le Mac ; ils restent candidats côté serveur pour transcrire de longs enregistrements (§11).
- **Mac client de 16 Go** (LLM sur le serveur) : le profil recommandé tient, avec environ 2 Go.
- **Si les 60 Go visaient une machine dédiée à la voix**, le meilleur choix en français serait Qwen3-ASR 1.7B ou Voxtral, servis par vLLM (option D). Le reste du plan ne change pas.

### 3.5 Synthèse vocale (phase 2)

Le choix se fait à l'oreille (spike S2), parmi des voix que le même moteur sait lire :

| Voix                              | Taille                       | Langues                                                                      | Licence                                              | Dans sherpa-onnx                                                  | Notes                                                                                  |
| --------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Supertonic 3 (Supertone)          | environ 99 M (int8, 122 Mio) | 31, dont le français et le néerlandais                                       | modèle sous OpenRAIL-M (usages restreints), code MIT | oui (mai 2026)                                                    | Styles de voix prédéfinis ; seul modèle qui couvre le français et le néerlandais       |
| Pocket TTS (Kyutai)               | 100 M (int8, 93 Mio)         | anglais, français (voix « estelle »), allemand, italien, portugais, espagnol | CC-BY-4.0                                            | export anglais seulement (janvier 2026) ; export français à faire | Streaming ; premier son en environ 200 ms ; environ 6× le temps réel sur 2 cœurs de M4 |
| Kokoro v1.0                       | 82 M (int8, 126 Mio)         | plusieurs, dont le français (une voix, `ff_siwis`)                           | Apache 2.0                                           | oui                                                               | Qualité française moyenne                                                              |
| Piper `fr_FR` (siwis, tom, upmc…) | environ 20 Mio en int8       | français ; voix néerlandaises disponibles (`nl_BE`, `nl_NL`)                 | variable selon la voix, certaines non commerciales   | oui                                                               | Très léger, timbre plus synthétique                                                    |
| Qwen3-TTS 0.6B ou 1.7B            | 0,6 à 1,7 B                  | 10, dont le français                                                         | Apache 2.0                                           | non (PyTorch ou MLX)                                              | Meilleure qualité, mais sur GPU : profil serveur                                       |

### 3.6 Gestion des modèles

| Option                                                      | Pour                                                                                                                                                                                  | Contre                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **M1. Téléchargés au premier usage, épinglés** (recommandé) | `.dmg` léger. Même parcours que l'image de la VM. Empreintes SHA-256 dans le code, donc chaîne d'approvisionnement maîtrisée. Miroir interne pour la souveraineté. Import hors ligne. | Code à écrire (L1) ; réseau nécessaire au premier usage                                                          |
| M2. Embarqués dans le `.dmg`                                | Hors ligne dès l'installation                                                                                                                                                         | 0,6 à 1 Go de plus pour tout le monde, même sans la voix ; changer de modèle exige une nouvelle version de l'app |
| M3. Confiés à Ollama                                        | Un seul gestionnaire                                                                                                                                                                  | Ni transcription documentée, ni synthèse française (§3.2 E)                                                      |
| M4. Confiés à macOS (SpeechAnalyzer)                        | Rien à gérer                                                                                                                                                                          | §3.2 C                                                                                                           |
| M5. Confiés au SDK (FluidAudio)                             | Téléchargement et compilation pour le Neural Engine gérés par le SDK                                                                                                                  | Cache hors de notre contrôle ; seulement avec l'option B                                                         |

Exception à M1 : le modèle Silero (0,6 à 2,2 Mo) est embarqué dans `Contents/Resources`.

## 4. Décisions

### D1. Phasage

- **Phase 0, spikes** : S1 (moteur dans l'app signée), S2 (écoute des voix), S3 (écho). Chacun a un critère de sortie (§6).
- **Phase 1, dictée** : lots L0 à L5. Livrable autonome, à parité avec Cowork. Elle ne touche ni agent-core ni le serveur.
- **Phase 2, conversation** : lots L6 à L11, lancés après S2 et S3.
- **Phase 3** : options décidées plus tard (§11).

### D2. Moteur : sherpa-onnx dans un `utilityProcess`

```
 Renderer (sandbox)                 Main                                    utilityProcess « voice »

 getUserMedia (écho, bruit, gain)
 AudioWorklet : PCM 16 kHz,         VoiceService
 trames de 100 ms ─ voice:audio ─▶    vérifie l'émetteur et la session ─▶   VAD Silero → segments
                                                                            Parakeet v3 → texte
 Bouton micro, mode vocal ◀───────  voice:transcript, voice:state ◀──────   texte, états
 Lecture de la voix (phase 2) ◀───  voice:audio-out ◀────────────────────   synthèse → PCM (phase 2)

                                    VoiceModelManager (téléchargement, SHA-256)
                                    ChatManager (phase 2 : tours de parole)
```

- **Process séparé** (`sherpa-onnx-node`, N-API) :
  - Un crash natif ne tue pas le main, et arrêter le process libère toute sa mémoire.
  - L'inférence ne bloque pas la boucle d'événements du main, qui porte les tours de l'agent, les permissions et la VM.
- **Tout passe par le main.**
  - L'audio arrive par un canal `invoke` typé (`voice:audio`), comme le reste de l'IPC. Le main vérifie l'émetteur (cadre principal de la fenêtre principale) et la session vocale, puis relaie au worker. Le débit est faible : 10 trames de 6,4 ko par seconde.
  - Le texte et les états remontent au main. Il les diffuse en événements IPC typés et, en phase 2, les transmet au `ChatManager`.
  - **Pourquoi pas de `MessagePort` direct** entre le renderer et le worker : `contextBridge` ne transmet pas de port. Il faudrait le relayer par `window.postMessage` et ouvrir un second canal hors du contrat IPC, pour gagner quelques millisecondes. S1 mesure le délai du relais ; le port reste une optimisation possible.
- **Interface `SpeechEngine`** (locale au package au départ) : un moteur serveur (D) ou natif (B) pourra s'y brancher sans toucher à l'UI.
- **Packaging**
  - `sherpa-onnx-node` et `sherpa-onnx-darwin-arm64` deviennent des dépendances de `@atelier/desktop`, externes au bundle comme `jsdom`.
  - `asarUnpack` pour `**/node_modules/sherpa-onnx-*/**`. electron-builder signe les `.node` et `.dylib`. L'app grossit de 34 Mo.
  - Pas de script d'installation : `allowBuilds` ne change pas.
  - Types : déclaration locale `packages/voice/src/types/sherpa-onnx-node.d.ts`, comme `jsdom.d.ts`.
- **Calcul** : CPU par défaut. S1 le compare au provider CoreML (Neural Engine). Le GPU reste réservé au LLM.

### D3. Capture audio

- **Dans le renderer.**
  - `getUserMedia({ audio: { echoCancellation, noiseSuppression, autoGainControl, deviceId } })` ouvre le micro.
  - Un `AudioWorklet` produit des trames de 100 ms en PCM mono 16 kHz (`Float32Array`), rééchantillonnées par Chromium ou dans le worklet.
  - Le worklet est un fichier de l'app, couvert par `script-src 'self'` : ni `blob:` ni `data:`.
  - Le niveau sonore du vu-mètre est calculé dans le renderer.
- **Pourquoi le renderer** : la permission et l'annulation d'écho de Chromium sont fournies, sans dépendance audio native supplémentaire.
- **Transport** : chaque trame part par `voice:audio` (`{ voiceSessionId, seq, pcm }`), soit environ 64 ko/s. Le main refuse une trame hors d'une session active ou venue d'un autre cadre. Le numéro de séquence révèle une perte ou un désordre.
- **Optimisation possible**, seulement si S1 mesure un relais trop lent : un `MessagePort` remis par le relais documenté d'Electron (`webContents.postMessage`, le preload, puis `window.postMessage` avec transfert, filtré sur `event.source === window`).

### D4. Modèles retenus

| Rôle                             | Modèle                                                                                                 | Embarqué ou téléchargé    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------- |
| Détection de parole              | Silero VAD (MIT)                                                                                       | embarqué                  |
| Reconnaissance                   | Parakeet TDT 0.6B v3 int8 (CC-BY-4.0)                                                                  | téléchargé (464 Mio)      |
| Reconnaissance, option           | Qwen3-ASR 0.6B int8 (Apache 2.0), si S1 le montre meilleur sur nos phrases                             | téléchargé (837 Mio)      |
| Synthèse (phase 2)               | choisie en S2                                                                                          | téléchargé (20 à 140 Mio) |
| Fin de tour (phase 2, en option) | Smart Turn v3.2 (BSD-2, 8 Mo, français pris en charge), seulement si le seuil de silence ne suffit pas | téléchargé                |

### D5. Gestion des modèles (`VoiceModelManager`, package `voice`, I/O injectées)

- **Catalogue dans le code** : identifiant, rôle, version, URL, **SHA-256**, taille, licence, attribution, langues, estimation de mémoire. Comme dans `fetch-lima.ts`, l'empreinte est épinglée dans le code, jamais lue sur le serveur de téléchargement.
- **Rangement** : `~/Library/Application Support/Atelier/models/voice/<id>@<version>/`. Ce dossier est hors de `~/Atelier` (les dossiers de l'utilisateur) et hors d'iCloud.
- **Installation atomique**, dans cet ordre :
  1. vérification de la place disque ;
  2. téléchargement dans un `.partial`, avec reprise (en-tête `Range`) ;
  3. contrôle du SHA-256 ;
  4. extraction dans un dossier temporaire par `tar` (macOS), appelé sans shell ;
  5. contrôle de la liste des fichiers : ceux attendus et rien d'autre, aucun chemin hors du dossier ;
  6. renommage final, puis écriture de `manifest.json`.
- **Sources**
  - Officielle : les releases GitHub de sherpa-onnx.
  - **Miroir** (`voice.modelSourceUrl`), avec la règle de `checkServerUrl` (https, sauf localhost et Tailscale) ; par exemple servi par le Caddy de `server/`.
  - **Import d'une archive** hors ligne, contrôlée par la même empreinte.
  - Un parc géré peut aussi déposer le dossier par MDM.
- **Mises à jour** : les modèles changent avec les versions de l'app (catalogue), jamais en silence. L'ancienne version est supprimée après la bascule.
- **Mémoire**
  - Chargement au premier usage. Préchargement au démarrage si la voix est active et que la machine a au moins 32 Go.
  - Arrêt du process après `idleUnloadMinutes` d'inactivité : 10 par défaut, 0 pour le garder chargé. S1 mesure le temps de rechargement.
- **Licences** : l'attribution des modèles CC-BY figure dans « À propos › Licences ». Le catalogue ne contient aucune voix non commerciale.

### D6. Dictée (phase 1)

- **Bouton micro** dans le Composer, à gauche du bouton d'envoi. Raccourci proposé : ⌘⇧D, à vérifier contre ⌘K, ⌘B et ⌘N.
- **Premier usage**
  - Le main demande l'autorisation macOS.
  - Si le modèle manque, une carte l'annonce avec une progression : « La dictée a besoin du modèle de reconnaissance (environ 490 Mo, téléchargé une fois, traité sur ce Mac). »
- **Pendant l'écoute**
  - Le bouton passe au rouge, avec un vu-mètre et un chronomètre. Le texte apparaît à chaque pause.
  - Un nouveau clic ou ⌘⇧D termine. Échap annule et retire le texte dicté.
  - Arrêt automatique au bout de 5 min.
- **Après** : le texte est inséré au curseur et reste modifiable ; Entrée envoie comme d'habitude. La dictée reste possible pendant un tour de l'agent.
- **Langue** : aucune à choisir, Parakeet la détecte. Il fournit ponctuation et majuscules. Quand le texte est en français, l'app ajoute les espaces insécables avant « : ; ! ? » et à l'intérieur des guillemets « ».
- **Accessibilité** : bouton libellé, état du micro annoncé par VoiceOver (`aria-live`).
- **Erreurs**, en français :
  - micro refusé, avec un lien vers Réglages Système › Confidentialité et sécurité › Micro ;
  - aucun micro ;
  - modèle absent ou corrompu ;
  - moteur arrêté.

### D7. Mode conversation (phase 2)

- **Entrée** : un bouton « Mode vocal » à côté du micro. Le mode s'applique à la conversation courante et à ses dossiers.
- **Tours de parole** : la détection de parole tourne dans le worker. La fin de tour arrive après 700 ms de silence (réglable), avec Smart Turn en option. Le transcript devient le message de l'utilisateur (`inputMode: 'voice'`).
- **Réponse**
  - Le main découpe le texte de l'agent en phrases.
  - Chaque phrase passe par un filtre « prononçable », puis par la synthèse. Le filtre retire markdown, tableaux, URL et chemins complets, et écrit en toutes lettres nombres, montants, dates et unités.
  - Le renderer joue l'audio. Le texte complet reste dans le fil.
- **Consignes du mode vocal** (agent-core, ajoutées au tour) et **thinking coupé** pendant ce tour :
  > Mode vocal : l'utilisateur t'écoute au lieu de lire. Réponds en français parlé, en une à trois phrases courtes, sans markdown, liste, tableau ni emoji. Ne lis jamais une URL, un chemin complet ou du code : dis ce que c'est (« le fichier des ventes de mars »). Si la réponse est longue, écris-la dans un fichier et résume-la en une phrase. Si tu as besoin d'une autorisation, dis que l'utilisateur doit la donner à l'écran.
- **Silence pendant les outils** : si un outil dure plus de 1,5 s, l'app prononce une courte phrase sans LLM (« Je lis ventes.csv. », « Je cherche sur le web. »), au plus une toutes les 5 s.
- **Interruptions** (V7)
  - L'utilisateur parle pendant que l'agent parle : la voix s'arrête en moins de 300 ms, le tour est arrêté (sémantique actuelle du Stop), et la nouvelle phrase devient le message suivant.
  - L'utilisateur parle pendant que l'agent travaille en silence : la phrase est mise en attente et envoyée à la fin du tour. « Stop », « arrête » ou « annule », dits seuls, arrêtent le tour.
  - Une modale de permission est ouverte : l'écoute est suspendue (« Réponds à l'écran »). **Aucune permission n'est donnée à la voix.**
- **Écho** (S3)
  - Si l'annulation d'écho de Chromium suffit, l'utilisateur interrompt à la voix.
  - Sinon, la v1 fonctionne en semi-duplex : le micro est ignoré pendant que l'agent parle, et l'interruption se fait au clavier ou au clic. L'option B reste possible ensuite.
- **Fin** : bouton, Échap, fenêtre fermée, mise en veille, ou 60 s sans parole.
- **Budget de latence** (cible : 2,5 s au plus en médiane)

| Étape                            | Durée visée | Hypothèse                                       |
| -------------------------------- | ----------- | ----------------------------------------------- |
| Fin de parole détectée           | 0,7 s       | seuil de silence (moins avec Smart Turn)        |
| Transcription du dernier segment | 0,1 à 0,3 s | Parakeet int8 sur CPU (mesuré en S1)            |
| Premier token du LLM             | 0,3 à 1 s   | cache de préfixe d'Ollama chaud, thinking coupé |
| Première phrase                  | 0,2 à 0,4 s | 104 tokens/s (QA)                               |
| Premier son                      | 0,2 s       | synthèse d'environ 100 M sur CPU                |

### D8. Permissions macOS et Electron

- **Info.plist** : `mac.extendInfo.NSMicrophoneUsageDescription` dans `electron-builder.yml`, avec le texte « Atelier utilise le micro pour transcrire votre voix sur ce Mac. L'audio n'est ni envoyé ni conservé. »
- **Entitlements** : `com.apple.security.device.audio-input` dans `entitlements.mac.plist` et `entitlements.adhoc.plist`. L'héritage couvre les process auxiliaires d'Electron, où la capture a lieu.
- **Accès au micro** : le main appelle `systemPreferences.getMediaAccessStatus('microphone')` et `askForMediaAccess('microphone')`, uniquement sur une action de l'utilisateur.
- **Gestionnaires de permission** : `setPermissionRequestHandler` et `setPermissionCheckHandler` n'accordent que `media`, avec `mediaTypes` égal à `['audio']`, demandé par le **cadre principal** de la **fenêtre principale**, à l'URL de l'app (fichier du renderer ou URL de dev). Tout le reste reste refusé : caméra, écran, aperçus (`atelier-file:`), artefacts (`atelier-artifact:`), visionneuse PDF.
- **En dev comme en production** : les gestionnaires sortent de `installContentSecurityPolicy`, qui ne s'applique pas en `pnpm dev` (§1). Sinon, le micro marcherait en dev et serait refusé dans l'app packagée.
- **Builds ad hoc** : la signature change à chaque build, donc macOS redemande l'accès au micro. À noter dans `docs/DEMO.md`.

### D9. Confidentialité

- Aucun fichier audio n'est écrit, ni dans `userData` ni dans le dossier temporaire. Les tampons sont libérés après la transcription, et les journaux ne contiennent jamais de transcript.
- Le transcript est un message comme un autre : il est gardé dans l'historique SQLite et envoyé au LLM (local ou serveur) comme un texte tapé.
- Même avec le LLM sur le serveur, la voix reste sur le Mac ; seule la transcription part. C'est de la minimisation au sens du RGPD, la voix étant une donnée personnelle.
- Pas d'écoute permanente ni de mot d'activation. Le micro ne s'ouvre que sur une action explicite, avec un indicateur visible en plus du point orange de macOS.
- L'étape Confidentialité de l'onboarding et Réglages › Voix l'expliquent.

### D10. Réglages › Voix

- Activer la voix.
- Micro : choix du périphérique ; test avec vu-mètre et transcription de 5 s.
- Reconnaissance : modèle, état, taille, suppression.
- Source des modèles (officielle ou miroir) et import.
- Libération de la mémoire après N minutes.
- En phase 2 : voix, vitesse, interruption à la voix, silence avant la réponse.

## 5. Contrat `packages/shared` (demande au Lead)

Tout est nouveau ou optionnel. `AgentEvent` ne gagne aucun membre.

```ts
// voice.ts (nouveau module), phase 1
export type VoiceModelRole = 'vad' | 'stt' | 'tts' | 'turn';
export type VoiceModelState = 'absent' | 'downloading' | 'installed' | 'loaded' | 'error';
export interface VoiceModelInfo {
  id: string; // 'parakeet-tdt-0.6b-v3-int8'
  role: VoiceModelRole;
  label: string; // « Parakeet v3 (25 langues européennes) »
  version: string;
  languages: readonly string[]; // BCP 47 : 'fr', 'nl', 'en'…
  downloadBytes: number;
  diskBytes: number;
  memoryEstimateBytes: number;
  license: string; // identifiant SPDX : 'CC-BY-4.0'
  attribution?: string;
  bundled: boolean; // embarqué dans l'app (détection de parole)
  state: VoiceModelState;
  progress?: { receivedBytes: number; totalBytes: number };
  error?: SerializedAtelierError;
}
export type MicAccess = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
export type VoiceEngineState = 'stopped' | 'loading' | 'ready' | 'error';
export interface VoiceStatus {
  mic: MicAccess;
  engine: VoiceEngineState;
  models: VoiceModelInfo[];
}
export type VoiceMode = 'dictation' | 'conversation'; // 'conversation' : phase 2
export type VoiceSessionState =
  | 'listening'
  | 'transcribing'
  | 'idle' // phase 1
  | 'thinking'
  | 'speaking'
  | 'waiting_permission'; // phase 2
export interface TranscriptSegment {
  voiceSessionId: string;
  index: number;
  text: string;
  final: boolean;
  startMs: number;
  endMs: number;
}
export interface VoiceSettings {
  enabled: boolean;
  sttModel: string;
  /** 0 = garder le moteur chargé. */
  idleUnloadMinutes: number;
  /** Miroir des modèles : https, ou http pour localhost et Tailscale (règle de checkServerUrl). */
  modelSourceUrl?: string;
  inputDeviceId?: string;
  // phase 2
  ttsVoice?: string;
  ttsRate?: number; // 0,8 à 1,3
  bargeIn?: boolean;
  endOfTurnSilenceMs?: number;
}
```

- **Réglages** : `AppSettings.voice?: VoiceSettings` (absent = valeurs par défaut).
- **Canaux `invoke`**
  - `voice:status` → `VoiceStatus`
  - `voice:request-mic` → `MicAccess`
  - `voice:open-mic-settings` → `undefined`
  - `voice:install-model`, `voice:cancel-install`, `voice:remove-model` : `{ id }` → `undefined`
  - `voice:import-model` : `{ id }` → `undefined` (le main ouvre le sélecteur de fichier)
  - `voice:start` : `{ mode: VoiceMode; sessionId?: string }` → `{ voiceSessionId }`
  - `voice:stop` : `{ voiceSessionId }` → `{ text: string }`
  - `voice:cancel` : `{ voiceSessionId }` → `undefined`
  - `voice:audio` : `{ voiceSessionId: string; seq: number; pcm: Float32Array }` → `undefined` (trames du micro, D3)
- **Événements** : `voice:status`, `voice:model` (`VoiceModelInfo`, progression comprise), `voice:transcript` (`TranscriptSegment`), `voice:state` (`{ voiceSessionId, state }`).
- **Preload** : inchangé. Les canaux `voice:*` passent par `invoke` et `on`, comme les autres ; le contrat ne contient aucun `MessagePort`.
- **Codes d'erreur** : `voice/mic_denied`, `voice/no_input`, `voice/model_missing`, `voice/model_invalid`, `voice/download_failed`, `voice/engine_failed`, `voice/busy`.
- **Écarts de L0** (PR `feat/lead-shared-voice`, d'après les mesures de S1) :
  - `VoiceSessionState` gagne `starting` : micro en cours d'ouverture, aucune trame reçue. Le main passe la session en `listening` à la première trame ; l'interface n'invite à parler qu'à ce moment (début de prise perdu, S1).
  - `voice:state` porte `warning?: 'silent_input'` : trames nulles depuis `VOICE_SILENT_INPUT_MS` (micro muet sans signal, S1).
  - `VoiceSettings.glossary?` : noms propres et marques à mieux reconnaître (hotwords sherpa-onnx, L2).
  - Constantes : `VOICE_SAMPLE_RATE`, `VOICE_FRAME_MS`, `VOICE_FRAME_SAMPLES`, `VOICE_PRE_ROLL_MS` (300 ms gardés avant chaque segment), `VOICE_SILENT_INPUT_MS`, `MAX_DICTATION_MS`, `DEFAULT_STT_MODEL`, `DEFAULT_VOICE_SETTINGS`.
  - `validateVoiceSettings` (fonction pure, messages en français) : modèle, délai de déchargement, miroir (règle de `checkServerUrl`), glossaire.
  - Le contrôle SHA-256 s'applique avant toute extraction et tout chargement, pour un téléchargement comme pour un import (`voice:install-model`, `voice:import-model`) : c'est écrit dans le contrat des canaux, et L1 le teste.
- **Phase 2** (L6) : `agent:send` gagne `inputMode?: 'dictation' | 'voice'`, et `ChatMessage.inputMode?` permet d'afficher une icône dans le fil. Nouvel événement `voice:audio-out` (`{ voiceSessionId, seq, sampleRate, pcm: Float32Array }`) pour la voix de l'agent. Aucun `switch` exhaustif à compléter.

## 6. Répartition (tickets #25 à #39)

Tailles : S pour au plus 1 jour d'agent, M pour 1 à 3 jours, L pour 3 à 5 jours.

| Lot | Ticket | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Dépend de | Taille |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------ |
| S1  | #25    | **Spike moteur.** sherpa-onnx-node 2.0.1 dans un `utilityProcess` du build `dist:mac:adhoc`, avec Silero et Parakeet v3 int8. Jeu de 20 phrases françaises, dont 10 dictées par Gilles avec du vocabulaire métier. Mesures : CPU contre CoreML, mémoire, chargement, débit de qwen3.5:35b pendant une transcription, délai du relais `voice:audio` pendant un tour de l'agent ; Qwen3-ASR 0.6B sur le même jeu ; si possible, les mêmes mesures sur un Mac de 16 Go (M1 ou M2). **Sortie** : texte final en 1 s au plus pour 15 s, 1,5 Go résidents au plus, perte de débit du LLM sous 5 %, relais sous 50 ms au 95e centile (sinon `MessagePort`), `codesign --verify --deep --strict` OK. Sinon, option B. | n/a       | S      |
| L0  | #26    | **shared** (Lead) : §5, phase 1. PR `feat/lead-shared-voice`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | S1        | S      |
| L1  | #27    | **`packages/voice`, modèles** : catalogue épinglé et `VoiceModelManager` (D5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | L0        | M      |
| L2  | #28    | **`packages/voice`, moteur** : protocole main ↔ worker validé par Zod ; adaptateur sherpa-onnx (détection de parole, reconnaissance) ; pipeline de dictée (segments, assemblage, typographie) ; arrêt à l'inactivité.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | L0        | M      |
| L3  | #29    | **main et packaging** : `VoiceService` (worker, relais audio, handlers IPC, événements), permissions (D8, en dev comme en production), entitlements, Info.plist, `asarUnpack`, dépendances externes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | L1, L2    | M      |
| L4  | #30    | **renderer** : capture et envoi des trames (D3), bouton micro (D6), carte de téléchargement, Réglages › Voix (D10), messages d'erreur, étape Confidentialité.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | L3        | M      |
| L5  | #31    | **QA** : e2e mock avec un faux moteur ; e2e réel avec un micro simulé par un fichier WAV (`--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture`) ; WER sur le jeu de S1 ; mémoire ; dictée hors ligne ; rapport dans `docs/QA.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | L4        | S      |
| S2  | #32    | **Spike écoute.** 10 réponses types d'Atelier lues par les voix du §3.5 (Pocket TTS si l'export français tient en une demi-journée) ; écoute à l'aveugle par Gilles ; licences vérifiées voix par voix ; vitesse et délai du premier son. **Sortie** : voix française par défaut (et néerlandaise selon V5).                                                                                                                                                                                                                                                                                                                                                                                                  | L5        | S      |
| S3  | #33    | **Spike écho.** Synthèse jouée par un élément `<audio>` (`srcObject`), puis par WebAudio, micro du MacBook ouvert avec annulation d'écho ; compte des faux déclenchements sur 20 réponses. **Sortie** : interruption à la voix si moins d'un faux déclenchement pour 10 réponses, sinon semi-duplex.                                                                                                                                                                                                                                                                                                                                                                                                          | L4        | S      |
| L6  | #34    | **shared** (Lead) : §5, phase 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | S2, S3    | S      |
| L7  | #35    | **voice, synthèse** : voix choisie en S2, découpage en phrases, filtre « prononçable » en français, flux audio vers le renderer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | L6        | M      |
| L8  | #36    | **agent-core** : consignes du mode vocal, thinking coupé pour le tour, phrases d'attente des outils.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | L6        | S      |
| L9  | #37    | **main, conversation** : orchestration des tours, interruptions selon S3, file d'attente, permissions, fin automatique.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | L7, L8    | L      |
| L10 | #38    | **renderer, mode vocal** : états, transcript, couper le micro, quitter ; lecture audio ; réglages de la voix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | L9        | M      |
| L11 | #39    | **QA** : latence entre fin de parole et premier son, interruptions, permissions, scénario réel, `docs/QA.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | L10       | M      |

**Chemin critique de la phase 1** : S1, L0, puis L1 et L2 (indépendants), L3, L4, L5.

**Ordre de grandeur** : phase 1, 6 à 15 jours d'agent ; phase 2, 8 à 18.

**Livraison (V6)**

- fullstack réalise les lots, une PR par lot, comme dans ADR-003.
- L0 et L6 sont soumis au Lead (règle n° 1 de `CLAUDE.md`). Core relit L8, UI relit L4 et L10.
- Fait le 2026-11-01 : demande inscrite dans `docs/STATUS.md`, section « Demandes d'évolution de `packages/shared` » ; tickets #25 à #39 créés, sous-tickets de #23, bloqués selon la colonne « Dépend de ». Seul S1 (#25) est prêt à démarrer.

## 7. Sécurité (brief §8)

- **Micro accordé au strict nécessaire** : audio seul, cadre principal de la fenêtre principale, origine de l'app. Ni les artefacts, ni les aperçus, ni la visionneuse PDF n'y ont accès.
- **La voix n'autorise rien.** Une phrase captée par le micro (vidéo qui joue à côté, collègue) ne peut ni donner une permission, ni changer un réglage. Le transcript est un message de l'utilisateur, soumis aux mêmes règles que le texte tapé.
- **Chaîne d'approvisionnement** : empreintes dans le code, extraction contrôlée. Aucun modèle n'est téléchargé depuis une URL fournie par un fichier ou par le modèle.
- **Process de voix** : il ne fait aucun appel réseau (les téléchargements ont lieu dans le main) et ne reçoit que des chemins de modèles validés.

## 8. Tests attendus (Definition of Done)

- **shared** : canaux et types ; validation de `modelSourceUrl` (règle de `checkServerUrl`).
- **voice**
  - Gestionnaire de modèles :
    - SHA-256 incorrect refusé (`voice/model_invalid`) ;
    - reprise après coupure ;
    - archive contenant un chemin `../` ou un fichier inattendu refusée ;
    - place disque insuffisante ;
    - installation atomique : rien d'installé à moitié après un crash simulé ;
    - suppression ; import hors ligne.
  - Pipeline de dictée, avec un moteur simulé : segments vers texte ; annulation ; durée maximale ; typographie française.
  - Protocole du worker : message invalide rejeté ; arrêt à l'inactivité ; redémarrage après un crash.
  - Test réel (Parakeet sur 3 fichiers WAV), skippé hors macOS arm64 ou sans `ATELIER_VOICE_IT=1`.
- **main**
  - Gestionnaires de permission, en dev comme en production : audio du cadre principal accordé ; caméra, sous-cadre, `atelier-artifact:` et `atelier-file:` refusés.
  - `voice:audio` : trame refusée hors d'une session active ou venue d'un sous-cadre ; perte et désordre détectés par `seq`.
  - État de l'autorisation macOS ; cycle de vie du worker.
  - Un seul enregistrement à la fois (`voice/busy`).
- **renderer** (fausse `window.atelier`) : états du bouton micro ; insertion au curseur ; Échap ; carte de téléchargement ; micro refusé ; Réglages › Voix.
- **e2e**, en mock (faux moteur) et en réel (micro simulé par un fichier WAV) : dictée d'une phrase, envoi, réponse ; dictée hors ligne après l'installation.
- **Phase 2**
  - Filtre « prononçable » : markdown, tableaux, URL, nombres, montants, dates. Découpage en phrases.
  - Orchestrateur : interruption pendant la voix, file d'attente pendant un outil, suspension pendant une permission, fin après 60 s de silence.
  - En réel : latence médiane de 2,5 s au plus sur 10 tours.
- `pnpm test && pnpm lint && pnpm typecheck` verts.

## 9. Risques

| Risque                                                         | Effet                                         | Parade                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Module natif dans l'app signée (asar, signature, notarisation) | Build cassé, ou voix muette une fois packagée | S1 sur le build ad hoc ; précédent de `sharp`                                                       |
| Écho dans Chromium                                             | L'agent s'interrompt lui-même                 | S3 ; semi-duplex ; option B                                                                         |
| Qualité de la voix française                                   | Mode vocal désagréable                        | S2 à l'oreille ; profil serveur (Qwen3-TTS) en phase 3                                              |
| Vocabulaire métier (noms propres, clients, lieux belges)       | Transcriptions fautives                       | Texte toujours modifiable en dictée ; mots-clés tirés des noms de fichiers et de projets en phase 3 |
| Concurrence avec le LLM                                        | Génération ralentie                           | CPU ou Neural Engine, jamais le GPU ; mesure en S1                                                  |
| Relais audio par le main pendant un tour chargé                | Trames en retard, texte qui tarde             | Mesure en S1 (95e centile) ; `MessagePort` direct si besoin                                         |
| Licences (CC-BY, OpenRAIL-M, voix Piper)                       | Non-conformité                                | Catalogue avec licence et attribution ; aucune voix non commerciale                                 |
| Autorisation macOS et builds ad hoc                            | Accès au micro redemandé à chaque build       | Noté dans `docs/DEMO.md` ; disparaît avec la signature Developer ID                                 |
| Premier token lent (prompt d'environ 4 000 tokens)             | Conversation peu naturelle                    | Thinking coupé en mode vocal ; cache de préfixe d'Ollama ; mesure en L11                            |

## 10. Options écartées

- **API Web Speech de Chromium** : elle s'appuie sur les services de Google et ne fonctionne pas dans Electron.
- **Un LLM audio comme agent** (Gemma 4 audio à la place de Qwen 3.5) : changerait le modèle validé par toute la QA (prompts, outils, compaction).
- **Modèles parole à parole** (Qwen3-Omni, Moshi, LFM3-Audio) : ils contournent la boucle de l'agent, ses outils, ses permissions et le fil écrit.
- **Gros modèles de transcription sur le Mac** (Voxtral Small 24B, Nemotron 3.5 Transcribe 30B-A4B) : 48 à 60 Go en BF16, incompatibles avec le LLM local (§3.4).
- **Whisper via whisper.cpp sur Metal** : moins précis et plus lent que Parakeet en français, et en concurrence avec le LLM sur le GPU.
- **Inférence dans le renderer** (transformers.js, onnxruntime-web) : exigerait `'wasm-unsafe-eval'` dans la CSP, et le renderer porte déjà l'interface.
- **Inférence dans la VM Lima** : la VM n'a ni GPU ni Neural Engine, et le micro est sur l'hôte.

## 11. Suites possibles (hors validation)

- **Moteur serveur** (option D) : routes `/v1/audio/*` dans le `Caddyfile`, servies par vLLM (Voxtral Realtime, Qwen3-ASR) ou Speaches. Utile pour les Mac de 8 à 16 Go et pour un profil « qualité ».
- **Fichiers audio comme documents** : `read_file` sur `.m4a`, `.mp3` et `.wav` produit une transcription horodatée, avec séparation des locuteurs (« résume cette réunion enregistrée »). Les gros modèles écartés sur le Mac ont leur place ici, côté serveur.
- **Mots-clés de reconnaissance** tirés des noms de fichiers, de dossiers et de projets : sherpa-onnx gère les hotwords des transducteurs NeMo.
- **Option B** (FluidAudio, Neural Engine, annulation d'écho native) si S1 ou S3 l'imposent, après validation d'un écart au tableau de stack.
- **Ollama** : à réévaluer s'il documente la transcription et une synthèse multilingue. La gestion des modèles pourrait alors lui revenir.

## 12. Sources (consultées le 2026-10-31)

- Anthropic, [Use voice mode](https://support.claude.com/en/articles/11101966-use-voice-mode) (dictée dans Cowork, pas de mode vocal) et [Voice mode ou dictée](https://academy.claude.com/tutorials/how-to-choose-between-voice-mode-and-dictation).
- NVIDIA, [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [Nemotron 3.5 ASR streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), [rapport technique de Nemotron 3.5 Transcribe](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3.5-Transcribe-Technical-Report.pdf).
- Whisper Notes, [Apple Speech, Qwen3-ASR, Whisper et Parakeet sur FLEURS](https://whispernotes.app/fr-BE/blog/apple-speech-vs-whisper) (septembre 2026, MacBook Air M5 ; publié par un éditeur qui intègre ces moteurs).
- Mistral, [Voxtral Mini 4B Realtime](https://huggingface.co/mistralai/voxtral-mini-4b-realtime-2602) et [Voxtral Transcribe 2](https://mistral.ai/news/voxtral-transcribe-2/).
- Alibaba, [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) ; [Qwen3-TTS](https://comfyui-wiki.com/en/news/2026-01-22-alibaba-qwen3-tts-release) (source secondaire).
- Kyutai, [Pocket TTS](https://huggingface.co/kyutai/pocket-tts) ; Supertone, [Supertonic 3](https://huggingface.co/Supertone/supertonic-3).
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (exemples Node, modèles précompilés) ; [FluidAudio](https://github.com/fluidinference/fluidaudio).
- Ollama, [Speech](https://docs.ollama.com/capabilities/speech) (synthèse `phonon`, anglais seulement) ; [demande d'entrée audio #11798](https://github.com/ollama/ollama/issues/11798).
- Daily, [Smart Turn v3](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/).
- atmoky, [annulation d'écho de Chromium et WebAudio](https://docs.atmoky.com/known-issues) ; BigBinary, [permissions micro dans Electron](https://bigbinary.com/blog/request-camera-micophone-permission-electron) ; [entitlement `audio-input` manquant](https://github.com/deepseek-ai/deepseek-harness/discussions/7989).
- Mesures locales : `ollama ps`, `ollama show` (Ollama 0.40.12), `docs/QA.md` (29/10/2026), paquet npm `sherpa-onnx-darwin-arm64` 2.0.1 (symboles N-API et version minimale de macOS).
- Electron, [contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge) (types transmissibles, sans `MessagePort`) et [MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports) (relais vers une page isolée), consultés le 2026-11-01.
