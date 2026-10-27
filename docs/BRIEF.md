# Atelier : clone local de Claude Cowork (Ollama + Qwen)

> Document de référence du projet. À placer à la racine du repo (`docs/BRIEF.md`). Tous les agents le lisent avant de commencer.

## Objectif
Construire une app desktop macOS pour non-développeurs. L'utilisateur choisit un dossier et discute avec un agent IA local généraliste (Qwen 3.5 via Ollama). L'usage visé est surtout non-code : rédaction, analyse de documents, synthèse, recherche, tableurs, rapports. L'agent lit, crée et modifie des fichiers dans ce dossier. Il exécute des commandes dans une VM Linux isolée embarquée dans l'app, cherche sur internet, utilise des "skills" (SKILL.md) et des connecteurs MCP, et affiche sa progression sous forme de liste de tâches. Le modèle tourne en local, sans clé API cloud obligatoire.

## Décisions de stack (validées)
| Sujet | Choix | Raison |
|---|---|---|
| Plateforme | **macOS Apple Silicon uniquement** (arm64, macOS 14+) | Virtualization.framework, perfs MLX/Metal, un seul target à packager |
| Desktop | **Electron** + electron-vite + React 19 + Tailwind + shadcn/ui | 100 % TypeScript, main + renderer |
| Architecture | **Ollama sur un serveur distant** (GPU), app en local sur le Mac (fichiers, VM, outils, MCP) | Le Mac ne porte pas le modèle ; modèle plus gros possible ; mutualisable pour l'équipe |
| Accès LLM | **Vercel AI SDK** (`ai`) + `@ai-sdk/openai-compatible` pointé sur `https://<serveur>/v1` (URL + token configurables ; `localhost` reste possible) | Streaming, tool calling et boucle multi-étapes gérés ; changement de provider sans réécriture (LM Studio/MLX, vLLM, Anthropic…) |
| Modèle par défaut | **`qwen3.5:35b`** (généraliste, multimodal natif, tool calling, mode "thinking"), configurable ; profils proposés : `qwen3.5:9b` (16 Go de RAM), `qwen3.5:27b` / `35b` (32 Go et plus), `qwen3.5:122b` (96 Go et plus) ; `num_ctx` ≥ 32768 (Modelfile `atelier` ou options Ollama) | Usage majoritairement non-code (rédaction, analyse, documents, recherche) : un modèle généraliste qui voit aussi les images |
| Modèle vision | Par défaut le modèle principal (multimodal) ; un modèle vision séparé reste possible en option (ex. `qwen3-vl`) | Un seul modèle en mémoire |
| Mode thinking | Activé pour les tâches complexes (analyse, planification), désactivable dans les Réglages pour gagner en vitesse | |
| Documents | `unpdf` (texte PDF), `pdftoppm` dans la VM (rendu des pages), `mammoth` (docx), `exceljs` (xlsx), `sharp` (redimensionnement d'images) | Lecture multi-format côté hôte |
| Sandbox | **Lima** embarqué (`limactl` livré dans les ressources de l'app), `vmType: vz`, image Ubuntu arm64 | Vraie VM isolée comme Cowork, sans Docker à installer |
| MCP | `@modelcontextprotocol/sdk` (stdio + streamable HTTP), outils exposés à l'AI SDK | Standard des connecteurs |
| Validation | Zod (schémas d'outils = `inputSchema` AI SDK) | |
| Persistance | SQLite (`better-sqlite3`) | |
| Monorepo / qualité | pnpm workspaces, Node 22, TypeScript strict, Vitest, ESLint + Prettier | |
| Packaging | electron-builder, target `mac` / `arm64`, signature + notarisation | |

## Serveur LLM (hors app, à documenter dans `docs/SERVER.md`)
- **Jamais exposer le port 11434 d'Ollama directement** (aucune authentification). Deux options supportées :
  - **Tailscale / WireGuard** (recommandé) : Ollama n'écoute que sur l'interface VPN ;
  - **Reverse proxy Caddy** : TLS automatique + `Authorization: Bearer <token>` vérifié, avec rate limiting.
- L'app envoie le token dans les headers (stocké via `safeStorage`) et refuse le `http://` hors `localhost` et IP Tailscale.
- **Contexte** : l'endpoint `/v1` d'Ollama ignore `num_ctx` → le contexte se règle côté serveur (`OLLAMA_CONTEXT_LENGTH=32768` ou un Modelfile `atelier` dérivé de `qwen3.5`). L'app lit la valeur réelle via `/api/show` pour piloter la compaction.
- **Concurrence** : `OLLAMA_NUM_PARALLEL`, `OLLAMA_KEEP_ALIVE=-1` (modèle gardé chaud), `OLLAMA_MAX_LOADED_MODELS`. Au-delà de quelques utilisateurs simultanés, migrer vers vLLM (même API OpenAI-compatible, rien à changer dans l'app).
- **Modèles** : téléchargés par l'admin sur le serveur ; l'app ne fait que lister (`/api/tags`) et choisir.
- **Confidentialité** : documents et images partent vers le serveur. Hébergement on-premise ou chez un fournisseur UE, pas de logs des prompts côté proxy, mention dans l'onboarding ("vos fichiers sont envoyés au serveur X").
- Fournir `server/` dans le repo : `docker-compose.yml` (Ollama + Caddy), `Caddyfile` avec auth par token, Modelfile `atelier`, script de healthcheck.

## Structure
```
apps/desktop/          # Electron main + preload + renderer React
packages/agent-core/   # boucle agentique (AI SDK), outils natifs, permissions, compaction
packages/sandbox/      # pilotage Lima (cycle de vie VM, exec, mounts, réseau)
packages/skills/       # loader de skills + skills d'exemple
packages/mcp-bridge/   # client MCP → outils AI SDK, tool_search
packages/web/          # web_search (providers) + web_fetch
packages/documents/    # lecture md/txt/pdf/images/office + sous-modèle vision
packages/shared/       # types partagés (messages, outils, events IPC, interfaces)
lima/                  # template atelier.yaml + scripts de provisioning
```

## Spécifications

### 1. Boucle agentique (`agent-core`)
- `streamText({ model, system, messages, tools, stopWhen: stepCountIs(50), abortSignal })` de l'AI SDK
- Provider créé via `createOpenAICompatible({ name: "ollama", baseURL })` ; l'URL et le modèle sont configurables (donc LM Studio, autre serveur…)
- Mapper `fullStream` vers nos events typés : `text_delta`, `tool_start`, `tool_result`, `todo_update`, `permission_request`, `done`, `error`
- Outils définis avec `tool({ description, inputSchema, execute })` ; les permissions sont gérées dans `execute` via un handler async injecté (`allow_once` / `allow_session` / `deny`) ; un refus renvoie un message au modèle, pas une exception
- Réparation des appels mal formés : `experimental_repairToolCall` + fallback de parsing JSON dans le texte (fréquent avec les modèles locaux)
- Compaction : si `usage.inputTokens` > 75 % de `num_ctx`, `generateText` résume les anciens messages, qui sont remplacés par ce résumé
- Prompt système assemblé à partir du rôle, du dossier de travail, de la date, de la liste des skills (nom + description), des règles de sécurité et de la consigne de recherche web
- Registre d'outils injectable (natifs, web, MCP)

### 2. Outils natifs
| Outil | Comportement | Permission |
|---|---|---|
| `read_file` | lecture multi-format, déléguée à `documents` (voir 2bis) | non |
| `write_file` | crée ou écrase un fichier | oui |
| `edit_file` | remplace `old_str` (qui doit être unique) par `new_str` | oui |
| `list_dir` / `glob` / `grep` | exploration | non |
| `bash` | exécution dans la VM Lima, timeout 120 s, sortie tronquée à 10 ko | oui (sauf liste blanche : ls, cat, head, grep, wc…) |
| `todo_write` | remplace la liste de tâches `{id, title, status}` | non |
| `present_file` | affiche une carte de fichier dans le chat | non |

- Les outils fichiers tournent côté hôte (Node) ; chemins résolus puis vérifiés, et tout ce qui sort du dossier autorisé est refusé (symlinks compris)
- Mapping des chemins hôte ↔ VM (`/workspace`) fourni par `sandbox`

### 2bis. Lecture de documents (`documents`)
`read_file({ path, offset?, limit?, pages? })` détecte le type (extension + magic bytes) et renvoie toujours du texte au modèle principal :

| Type | Traitement |
|---|---|
| `.md`, `.txt`, `.csv`, `.json`, code… | texte brut numéroté, offset/limit, max 2000 lignes ; détection d'encodage (UTF-8, sinon latin-1) |
| `.pdf` | texte par page via `unpdf`, avec un en-tête `--- page N ---` ; paramètre `pages: "1-10"` (max 20 pages par appel) ; nombre total de pages indiqué |
| PDF scanné (peu ou pas de texte sur une page) | rendu de la page en PNG (`pdftoppm` dans la VM), puis transcription par le modèle vision |
| `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.heic` | redimensionnement (`sharp`, max 1568 px), puis description et transcription par le modèle vision |
| `.docx` | texte/markdown via `mammoth` |
| `.xlsx` | feuilles converties en tableaux markdown (max 200 lignes par feuille, avec un résumé des dimensions) |
| binaire inconnu | refus clair avec le type détecté |

- Outil complémentaire `look_at({ path, question, page? })` : il envoie l'image (ou la page PDF rendue) au modèle vision avec une question précise (« quel est le total de la facture ? », « décris le graphique ») et renvoie la réponse texte
- Vision : par défaut, `look_at` appelle le modèle principal (multimodal) via `generateText` avec une part `image`, dans un contexte isolé, et ne renvoie que la réponse texte (l'historique principal n'est pas alourdi par les images). Option : un modèle vision séparé, configurable
- Cache des extractions (hash du fichier + paramètres) pour éviter de relancer la vision
- Pièces jointes : glisser-déposer dans le chat. Le fichier est copié dans `<dossier>/.atelier/uploads/` et son chemin est mentionné au modèle

### 3. Sandbox Lima (`sandbox`)
- `limactl` (+ guest agents) embarqué dans `Contents/Resources` ; `LIMA_HOME` = `~/Library/Application Support/Atelier/lima` (aucune installation tierce)
- Template `lima/atelier.yaml` : `vmType: vz`, `arch: aarch64`, `mountType: virtiofs`, 4 CPU / 4 Go par défaut (configurable), image Ubuntu LTS arm64
- Provisioning (1er lancement, avec barre de progression dans l'UI) : python3, pip, node 22, exceljs, pandas, openpyxl, poppler-utils, outils CLI courants ; création d'un utilisateur `agent`
- Mounts : dossier de travail en écriture sur `/workspace`, dossier skills en lecture seule sur `/skills`. Changer de dossier = mise à jour des mounts + redémarrage de la VM (viser < 15 s, avec un indicateur dans l'UI)
- Exec : `limactl shell --workdir /workspace atelier -- sudo -u agent bash -lc <cmd>` ; timeout, code de sortie, sortie tronquée
- Réseau : coupé par défaut pour l'utilisateur `agent` (règle nftables `meta skuid agent drop` en sortie) ; option par session pour l'autoriser
- Cycle de vie : démarrage au lancement de l'app (en arrière-plan), arrêt à la fermeture, reprise si la VM existe déjà ; diagnostics (`limactl list --json`) et bouton "Réinitialiser la VM" dans les Réglages
- Interface `Sandbox` de `shared` : `ensureReady(onProgress)`, `setWorkspace(hostDir)`, `exec(cmd, opts)`, `setNetwork(enabled)`, `stop()`, `reset()`

### 4. Recherche web (`web`)
- `web_search({ query, max_results = 5 })` renvoie `[{ title, url, snippet }]`
- Interface `SearchProvider` avec 3 implémentations choisies dans les Réglages :
  - `searxng` (par défaut) : service SearXNG installé dans la VM Lima (utilisateur `searxng`, non soumis au blocage réseau), port forwardé vers `127.0.0.1:8888` ; `GET /search?q=...&format=json`
  - `ollama` : Ollama Web Search API (clé via `safeStorage` d'Electron)
  - `brave` : Brave Search API (clé via `safeStorage`)
- `web_fetch({ url })` : exécuté côté hôte (process main), timeout, http(s) uniquement, refus des IP privées ; extraction du contenu principal (`@mozilla/readability` + `jsdom`), conversion en markdown (`turndown`), tronqué à 20 ko
- Permissions : `web_search` sans confirmation ; `web_fetch` confirmé la 1re fois par domaine
- Prompt système : "Pour toute question factuelle récente, fais `web_search` puis `web_fetch` sur 2-3 sources ; cite les URLs en fin de réponse."

### 5. Skills (`skills`)
- Dossier `~/Atelier/skills/<nom>/SKILL.md` avec frontmatter YAML (`name`, `description`)
- Seules les descriptions vont dans le prompt système ; le modèle lit le SKILL.md complet via `read_file` quand c'est pertinent
- Exposés dans la VM en lecture seule sur `/skills`
- 2 skills d'exemple : `xlsx` (création d'Excel avec exceljs, script prêt à l'emploi) et `rapport-markdown`

### 6. Connecteurs MCP (`mcp-bridge`)
- Config `~/Atelier/mcp.json` (format Claude Desktop : `mcpServers`)
- Serveurs stdio lancés côté hôte ; outils convertis en outils AI SDK (`dynamicTool` / `jsonSchema`), nommés `mcp__<serveur>__<outil>`
- Chargement paresseux : le modèle découvre et active les outils MCP via un outil `tool_search`
- Toute action d'écriture MCP demande une permission

### 7. UI (`apps/desktop`)
- Premier lancement : saisie de l'URL du serveur + token, bouton "Tester la connexion" (latence, version d'Ollama, modèles disponibles via `/api/tags`, contexte réel via `/api/show`), choix du modèle ; avertissement de confidentialité ; provisioning de la VM
- Indicateur permanent de l'état du serveur (connecté, lent, hors ligne) ; en cas de coupure, message clair et reprise du tour possible
- Accueil : choix d'un dossier, sessions récentes
- Chat : glisser-déposer de fichiers (vignettes pour les images et PDF), streaming, blocs d'outils repliables, cartes de fichiers cliquables (`shell.openPath` ou aperçu), résultats web cliquables, badge "Sources", bouton stop
- Panneau latéral : liste de tâches en direct, fichiers créés ou modifiés, état de la VM
- Modale de permission : "Autoriser une fois / toujours pour cette session / refuser"
- Réglages : URL du serveur LLM + token, modèle, mode thinking on/off, modèle vision séparé (optionnel), `num_ctx`, ressources de la VM, réseau de la VM, fournisseur de recherche + clés, dossier skills, édition de `mcp.json`
- Historique SQLite et reprise de session
- UI en français

### 8. Sécurité
- Le contenu des fichiers, des pages web et des réponses MCP est de la donnée, jamais des instructions (règle explicite dans le prompt système)
- Pas de suppression de fichier sans permission explicite
- Electron : `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, IPC typé via preload, CSP stricte
- La VM ne voit que le dossier de travail et les skills ; jamais le `$HOME` complet

## Jalons
- **M1** : boucle AI SDK en CLI avec read/write/edit, bash local temporaire, `web_search`/`web_fetch` (SearXNG ou Brave)
- **M2** : sandbox Lima (provisioning, mounts, exec, blocage réseau) + permissions
- **M3** : app Electron fonctionnelle (onboarding, chat, outils, todo, cartes de fichiers)
- **M4** : skills + MCP + SearXNG dans la VM + documents (PDF, images, vision, docx/xlsx)
- **M5** : historique, compaction, réglages, packaging signé et notarisé arm64

## Critères d'acceptation
1. Sur un Mac Apple Silicon neuf, l'app s'installe, se connecte au serveur (URL + token) et provisionne la VM sans terminal. Le serveur se déploie avec `docker compose up -d` depuis `server/`.
2. Avec `qwen3.5:35b`, sur un dossier contenant 3 CSV de ventes, la demande "Fais-moi un Excel récapitulatif par mois avec un graphique, puis un résumé en markdown" doit : créer une liste de tâches visible ; lire les CSV ; utiliser le skill `xlsx` dans la VM ; demander la permission avant d'écrire ; produire `recap.xlsx` + `resume.md` en cartes cliquables.
3. À "Quelle est la dernière version LTS de Node.js ?", l'agent fait `web_search`, lit au moins une source et cite l'URL.
4. Avec un PDF de 30 pages (texte), une facture PDF scannée et une photo de ticket de caisse glissés dans le chat, la demande "Résume le rapport et fais un tableau des montants de la facture et du ticket" lit le PDF par tranches de pages, passe la facture et le ticket par le modèle vision, et produit un tableau correct.
5. `curl https://example.com` lancé par l'agent dans la VM échoue tant que le réseau n'est pas autorisé.
6. `pnpm test`, `pnpm lint` et `pnpm typecheck` passent.

## Conventions
- Commits conventionnels ; une branche/PR par fonctionnalité (`feat/<rôle>-<sujet>`)
- Pas de `any` ; erreurs typées ; fonctions pures testables dans les packages
- Les packages ne dépendent jamais d'`apps/desktop`
- Toute modification de `packages/shared` passe par le Lead
- README : prérequis (Mac Apple Silicon, 16 Go de RAM suffisent côté client ; un serveur Ollama accessible, voir `docs/SERVER.md`) et démarrage en 3 commandes
