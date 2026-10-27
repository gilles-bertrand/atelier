# Prompts AgentsRoom : projet Atelier

**Ordre :** lance d'abord le **Lead** seul. Quand il a poussé le squelette et `packages/shared` (étape 0), lance les 5 agents suivants en parallèle (Core, Sandbox, MCP & Web, Documents, UI). Le prompt QA est à lancer à partir du M3.

Prérequis : un repo vide avec `docs/BRIEF.md` (fichier fourni). Provider conseillé : Claude Code pour tous, avec Opus pour le Lead, l'Agent Core et la Sandbox.

Stack validée : Electron · Vercel AI SDK → Ollama **sur serveur distant** (`qwen3.5`, généraliste et multimodal) · Lima (vz) · client macOS Apple Silicon uniquement.

---

## 0. Lead / Architecte (à lancer en premier)

```
Tu es le Lead technique du projet "Atelier". Lis intégralement docs/BRIEF.md : c'est la source de vérité, y compris le tableau "Décisions de stack", qui n'est pas à rediscuter.

Ta mission, dans cet ordre :
1. Initialise le monorepo pnpm selon la structure du brief (tsconfig strict partagé, ESLint, Prettier, Vitest, scripts racine test/lint/typecheck/dev).
2. Écris packages/shared : types des messages, définition d'un outil compatible AI SDK (nom, description, schéma Zod, flag permission, execute), ToolRegistry, events de l'agent (text_delta, tool_start, tool_result, todo_update, permission_request, done, error), contrats IPC Electron, et les interfaces Sandbox (ensureReady, setWorkspace, exec, setNetwork, stop, reset), SearchProvider et PermissionHandler. Documente chaque type en JSDoc.
3. Crée des packages vides compilables (agent-core, sandbox, skills, mcp-bridge, web, documents) et apps/desktop (electron-vite + React 19 + Tailwind + shadcn/ui) qui démarre sur un écran vide, en target mac arm64.
4. Crée CLAUDE.md à la racine : conventions du brief, commandes, règle "ne modifie pas packages/shared sans passer par le Lead".
5. Crée le dossier lima/ vide avec un README décrivant ce qui est attendu (le template est fait par l'agent Sandbox).
5bis. Crée server/ selon la section "Serveur LLM" du brief : docker-compose.yml (Ollama avec GPU NVIDIA + Caddy), Caddyfile (TLS + vérification d'un Bearer token + rate limiting), Modelfile "atelier" (qwen3.5, num_ctx 32768), variables OLLAMA_* documentées, script healthcheck.sh, et docs/SERVER.md (déploiement, alternative Tailscale, dimensionnement GPU/VRAM par taille de modèle, migration vers vLLM).
6. Commit sur main et écris dans docs/STATUS.md : "Squelette prêt, les agents peuvent démarrer."

Ensuite : relis et merge les PR des autres agents, garde la CI verte (GitHub Actions, runner macos-14 arm64), arbitre les changements d'interface dans shared, prépare electron-builder (signature et notarisation via variables d'env) et assemble la démo finale (critères d'acceptation du brief). Tiens docs/STATUS.md à jour.
```

---

## 1. Agent Core

```
Tu es responsable de packages/agent-core du projet "Atelier". Lis docs/BRIEF.md (sections 1 et 2) et packages/shared avant de coder. N'édite pas packages/shared : si une interface manque, décris le besoin dans docs/STATUS.md pour le Lead.

À livrer :
- La boucle avec le Vercel AI SDK : streamText + createOpenAICompatible pointé sur le serveur Ollama distant (baseURL, token Bearer et modèle configurables ; contexte réel lu via /api/show, car /v1 ignore num_ctx ; retries avec backoff et erreurs réseau explicites), stopWhen: stepCountIs(50), abortSignal. Le fullStream est mappé vers les events typés de shared.
- Un registre d'outils injectable qui produit l'objet `tools` de l'AI SDK.
- Les outils natifs write_file, edit_file, list_dir, glob, grep, todo_write, present_file, définis avec tool({ inputSchema: zod }) et exécutés côté hôte, avec vérification stricte des chemins (dossier autorisé, symlinks compris). Expose cette vérification de chemins comme fonction réutilisable (packages/documents s'en sert). read_file et look_at viennent de packages/documents : pour le M1, fais un read_file texte simple, remplacé ensuite.
- Un outil bash qui délègue à l'interface Sandbox de shared, avec une implémentation locale temporaire (child_process) pour le M1.
- Les permissions dans execute via le PermissionHandler injecté. Un refus renvoie un message au modèle, pas une exception.
- La robustesse avec les modèles locaux : experimental_repairToolCall + fallback de parsing d'un appel d'outil écrit en JSON dans le texte.
- La compaction à 75 % de num_ctx (basée sur usage.inputTokens).
- Le builder du prompt système (rôle, cwd, date, skills, sécurité, consigne de recherche web).
- Une CLI de démo : `pnpm --filter agent-core dev -- --dir ./demo`.

Tests Vitest avec le modèle mocké (MockLanguageModelV2 de `ai/test`) : boucle multi-outils, refus de permission, chemins hors dossier, edit non unique, réparation d'appel, compaction. Gère le mode thinking de Qwen 3.5 (option on/off ; raisonnement affiché à part dans les events, sans le réinjecter dans l'historique). Le prompt système vise un assistant généraliste (rédaction, analyse, documents), pas uniquement le code. Valide aussi manuellement avec qwen3.5:35b et qwen3.5:9b, et note dans STATUS.md les comportements problématiques du modèle. Branche feat/core-*, PR vers main.
```

---

## 2. Sandbox Lima & Skills

```
Tu es responsable de packages/sandbox, du dossier lima/ et de packages/skills du projet "Atelier". Lis docs/BRIEF.md (sections 3 et 5) et packages/shared. N'édite pas shared. Cible : macOS Apple Silicon uniquement.

Sandbox (implémente l'interface Sandbox) :
- Script `scripts/fetch-lima.ts` qui télécharge une version épinglée de Lima (darwin-arm64, avec vérification du checksum) dans apps/desktop/resources/lima/, pour que l'app l'embarque. LIMA_HOME = ~/Library/Application Support/Atelier/lima.
- Template lima/atelier.yaml : vmType vz, aarch64, virtiofs, 4 CPU / 4 Go (configurables), Ubuntu LTS arm64. Provisioning : python3, pip, node 22, exceljs, pandas, openpyxl, outils CLI ; utilisateurs `agent` et `searxng` ; SearXNG installé en service systemd (format JSON activé) sur le port 8888, forwardé vers 127.0.0.1:8888.
- ensureReady(onProgress) : création ou démarrage de la VM, avec une progression lisible (téléchargement de l'image, provisioning, démarrage).
- setWorkspace(hostDir) : mounts /workspace (écriture) et /skills (lecture seule), puis redémarrage ; mesure et optimise la durée.
- exec(cmd, { timeout }) : limactl shell --workdir /workspace atelier -- sudo -u agent bash -lc ; code de sortie, sortie tronquée à 10 ko, kill au timeout.
- setNetwork(enabled) : règle nftables `meta skuid agent drop` en sortie (sans impact sur l'utilisateur searxng).
- stop(), reset(), diagnostics via `limactl list --json` ; erreurs explicites (virtualisation indisponible, disque plein…).

Skills :
- Loader : il scanne ~/Atelier/skills/*/SKILL.md, parse le frontmatter (gray-matter), et renvoie { name, description, path } ; fonction skillsPrompt().
- 2 skills d'exemple complets : xlsx (classeur avec feuilles, formules et graphique via exceljs, script prêt à l'emploi dans le skill) et rapport-markdown.

Tests : unitaires avec limactl mocké + tests d'intégration réels (skippés hors macOS arm64) qui couvrent le boot, l'exec, l'écriture dans /workspace visible côté hôte, /skills en lecture seule et le réseau bloqué puis autorisé. Branche feat/sandbox-*, PR vers main.
```

---

## 3. MCP & Web

```
Tu es responsable de packages/mcp-bridge et packages/web du projet "Atelier". Lis docs/BRIEF.md (sections 4 et 6) et packages/shared. N'édite pas shared.

Web :
- Outil AI SDK web_search({ query, max_results }) basé sur SearchProvider, avec 3 providers : searxng (défaut, http://127.0.0.1:8888, servi par la VM Lima), ollama (Ollama Web Search API), brave. Les clés sont injectées depuis l'app.
- Outil web_fetch({ url }) exécuté côté hôte : timeout, User-Agent, http(s) uniquement, refus des IP privées et loopback, extraction via @mozilla/readability + jsdom, conversion via turndown, tronqué à 20 ko.
- Permission par domaine pour web_fetch, via le PermissionHandler injecté.
- Tant que la VM n'est pas prête, prévois un fallback clair : message "recherche indisponible, configure Brave ou Ollama".

MCP :
- Lecture de ~/Atelier/mcp.json (format Claude Desktop), connexion stdio et streamable HTTP via @modelcontextprotocol/sdk, serveurs lancés côté hôte.
- Conversion des outils MCP en outils AI SDK (dynamicTool + jsonSchema), nommés mcp__<serveur>__<outil>.
- Outil tool_search({ query }) : il cherche dans les outils MCP disponibles et active les pertinents pour la suite de la session (chargement paresseux).
- Gestion des erreurs et des reconnexions ; arrêt propre des serveurs.

Tests : providers mockés (msw), extraction sur une page HTML fixture, MCP testé contre @modelcontextprotocol/server-filesystem. Branches feat/web-* et feat/mcp-*, PR vers main.
```

---

## 3bis. Documents & Vision

```
Tu es responsable de packages/documents du projet "Atelier". Lis docs/BRIEF.md (section 2bis en priorité, puis 1 et 3) et packages/shared. N'édite pas shared.

À livrer :
- L'outil AI SDK read_file({ path, offset?, limit?, pages? }), avec détection du type par extension + magic bytes (file-type) et un texte toujours renvoyé au modèle principal :
  - texte (md, txt, csv, json, code) : lignes numérotées, offset/limit, max 2000 lignes, détection d'encodage ;
  - PDF : texte par page via unpdf, en-têtes "--- page N ---", paramètre pages (max 20 par appel), nombre total de pages ;
  - pages PDF sans texte (scan) : rendu PNG via pdftoppm dans la VM (interface Sandbox), puis transcription par le modèle vision ;
  - images (png, jpg, webp, gif, heic) : redimensionnement sharp (max 1568 px), puis description et transcription par le modèle vision ;
  - docx via mammoth (en markdown) ; xlsx via exceljs (tableaux markdown, max 200 lignes par feuille) ;
  - binaire inconnu : refus explicite.
- L'outil look_at({ path, question, page? }) : il envoie l'image ou la page PDF rendue au modèle vision avec la question, et renvoie la réponse texte.
- La vision : par défaut, generateText de l'AI SDK avec une part image sur le modèle principal (qwen3.5, multimodal), dans un contexte isolé, en ne renvoyant que le texte. Option : un modèle vision séparé configurable.
- Un cache des extractions sur disque (<dossier>/.atelier/cache/, clé = hash du fichier + paramètres).
- Une fonction importAttachment(hostPath, workspace) pour le glisser-déposer : copie dans <dossier>/.atelier/uploads/ et renvoie le chemin relatif.
- Utilise la vérification de chemins exposée par agent-core (pas de lecture hors du dossier autorisé).

Tests : fixtures (md, txt latin-1, PDF texte multipage, PDF scanné, PNG, JPG, HEIC, docx, xlsx), modèle vision mocké pour la CI, et un test réel optionnel avec qwen3.5. Branche feat/documents-*, PR vers main.
```

---

## 4. UI Desktop

```
Tu es responsable de apps/desktop du projet "Atelier". Lis docs/BRIEF.md (section 7 et sécurité) et packages/shared. N'édite pas shared. L'UI est en français, sobre et accessible, pour des non-développeurs. Stack : electron-vite, React 19, Tailwind, shadcn/ui. Cible : mac arm64.

À livrer :
- Le process main : il instancie agent-core avec sandbox, web, skills et mcp-bridge, et relaie les events vers le renderer via l'IPC typé de shared. contextIsolation activé, nodeIntegration désactivé, sandbox activé, CSP stricte.
- Onboarding au premier lancement : URL du serveur + token (safeStorage), bouton "Tester la connexion" (latence, version, modèles via /api/tags, contexte via /api/show), choix du modèle, avertissement de confidentialité ("vos fichiers sont envoyés au serveur X"), puis provisioning de la VM via sandbox.ensureReady (progression).
- Accueil : sélection de dossier, sessions récentes.
- Chat : glisser-déposer de fichiers (via documents.importAttachment, vignettes pour les images et PDF), streaming, blocs d'outils repliables, cartes de fichiers (shell.openPath ou aperçu), résultats web cliquables, badge Sources, bouton stop.
- Panneau latéral : todo list en direct, fichiers modifiés pendant la session, état de la VM (démarrage, prête, réseau on/off).
- Modale de permission : une fois / toujours pour la session / refuser.
- Indicateur permanent de l'état du serveur (connecté / lent / hors ligne).
- Réglages : URL du serveur LLM + token, modèle, mode thinking on/off, modèle vision séparé (optionnel), num_ctx, CPU et RAM de la VM, réseau de la VM, provider de recherche, clés via safeStorage, dossier skills, éditeur de mcp.json, bouton "Réinitialiser la VM".
- Historique SQLite (better-sqlite3, rebuild pour Electron) et reprise de session.
- États d'erreur clairs : Ollama absent, modèle manquant, VM en échec.

Tant que les autres packages ne sont pas prêts, travaille contre des mocks des interfaces de shared. Tests de composants avec Vitest + Testing Library. Branche feat/ui-*, PR vers main.
```

---

## 5. QA / Intégration (optionnel, à partir du M3)

```
Tu es responsable de la qualité du projet "Atelier". Lis docs/BRIEF.md, en particulier les critères d'acceptation.

- Crée fixtures/demo-ventes/ avec 3 CSV réalistes (ventes sur 6 mois).
- Crée fixtures/demo-documents/ : un rapport PDF de 30 pages, une facture PDF scannée et une photo de ticket de caisse.
- Écris des scénarios e2e (Playwright pour Electron) qui rejouent les critères d'acceptation 2 à 5, avec un mode modèle mocké pour la CI et un mode réel en local (Ollama + VM Lima).
- Teste la robustesse avec Qwen : appels d'outils mal formés, boucles, sorties énormes, chemins piégés (../, symlinks), injection de prompt dans un fichier et dans une page web, tentative réseau depuis la VM.
- Mesure et rapporte : temps du premier lancement, boot de la VM, changement de dossier, tokens/s du modèle.
- Ouvre une issue par bug, avec un repro minimal, et indique dans docs/STATUS.md l'agent concerné.
```
