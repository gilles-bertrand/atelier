# STATUS : Atelier

**Squelette prêt, les agents peuvent démarrer.**

_Dernière mise à jour : 2026-10-28, Lead._

## État par jalon

| Jalon                                                       | État                                                                                         | Responsable(s)                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| M0 : squelette monorepo + `packages/shared` + `server/`     | ✅ fait                                                                                      | Lead                          |
| M1 : boucle AI SDK en CLI, outils fichiers, bash local, web | 🟡 Core livré (PR `feat/core-agent-loop`), web livré (PR `feat/web-search-fetch`)            | Core, MCP & Web               |
| M2 : sandbox Lima + permissions                             | 🟡 sandbox livrée (PR `feat/sandbox-lima`), permissions : Core                               | Sandbox, Core                 |
| M3 : app Electron fonctionnelle                             | 🟡 process main branché (PR `feat/ui-shell`), écrans à venir                                 | UI                            |
| M4 : skills + MCP + SearXNG + documents                     | 🟡 skills + SearXNG dans la VM livrés ; MCP livré (PR `feat/mcp-bridge`) ; documents à faire | Sandbox, MCP & Web, Documents |
| M5 : historique, compaction, réglages, packaging signé      | ⏳                                                                                           | UI, Core, Lead                |

## Ce que contient le squelette

- Monorepo pnpm 11 (`apps/*`, `packages/*`), TypeScript 6 strict partagé (`tsconfig.base.json`), ESLint 10 (`strictTypeChecked`, `no-explicit-any`), Prettier, Vitest 5 (projets par package).
- `packages/shared` : erreurs typées (`AtelierError`), messages de chat, `ToolDefinition` / `defineTool` / `ToolRegistry` (+ `InMemoryToolRegistry`), `AgentEvent` (text_delta, reasoning_delta, tool_start, tool_result, todo_update, permission_request, sources, compaction, done, error), contrats IPC (`IpcInvokeContract`, `IpcEventContract`, `AtelierApi`), interfaces `Sandbox`, `SearchProvider`, `PermissionHandler`, réglages, config LLM, et `checkServerUrl` (https obligatoire hors localhost/Tailscale).
- Packages vides compilables : `agent-core`, `sandbox`, `skills`, `mcp-bridge`, `web`, `documents`.
- `apps/desktop` : Electron 45 + electron-vite 6 + React 19 + Tailwind 4 + shadcn/ui (Button, `cn`, thème neutral), preload `sandbox: true` avec liste blanche des canaux IPC, CSP stricte en production. L'app démarre sur un écran vide (vérifié en local).
- `apps/desktop/electron-builder.yml` : mac arm64 (dmg + zip), hardened runtime, notarisation via variables d'env.
- `server/` : `docker-compose.yml` (Ollama GPU NVIDIA + Caddy), `Caddyfile` (TLS, Bearer, rate limit, liste blanche des routes), `Modelfile` `atelier`, `.env.example`, `healthcheck.sh`. Documentation : `docs/SERVER.md`.
- CI GitHub Actions (`macos-14`) : format, lint, typecheck, test, build.

## Dépôt et CI

- Dépôt **public** : https://github.com/gilles-bertrand/atelier (public pour bénéficier des runners macOS gratuits).
- CI verte sur `main` (macos-14 : format, lint, typecheck, test, build).
- Ne committez jamais de secret ni de config locale (`.env`, `.mcp.json`, `.agentsroom/`).

## Notes du Lead pour les agents

- **AI SDK v7** (et non v5) : `tool({ description, inputSchema, execute })` et `streamText` sont inchangés ; le mock de test est `MockLanguageModelV4` (`ai/test`).
- Les outils se définissent avec `defineTool` (`@atelier/shared`) ; `agent-core` les convertit en outils AI SDK en injectant `ToolExecutionContext`.
- `ToolExecutionContext.sandbox` est optionnel (VM pas encore prête) : les outils doivent dégrader proprement.
- Les packages sont consommés en source TS (pas de build par package) ; electron-vite les bundle.
- Pour les dépendances natives (`better-sqlite3`, `sharp`), l'autorisation des scripts d'installation se fait dans `pnpm-workspace.yaml` (`allowBuilds`) : demandez au Lead.

## Sandbox & Skills (agent Sandbox, `feat/sandbox-lima`)

- **Lima 2.2.1** épinglé (SHA-256) : `pnpm fetch:lima` → `apps/desktop/resources/lima/` (`limactl`, guest agent, licence). `pnpm dist:mac` l'appelle d'abord.
- **`LimaSandbox`** (`@atelier/sandbox`) implémente `Sandbox` : création/démarrage/provisioning avec progression (`checking` → `downloading_image` → `starting` → `provisioning` (marqueurs des scripts) → `ready`), `setWorkspace` (stop → `limactl edit` → start, sans redémarrage si le dossier est inchangé ou si la VM ne tourne pas), `exec` (utilisateur `agent`, `/workspace`, délai tué par groupe de processus, annulation, sortie 10 ko tête + queue), `setNetwork` (nftables), `stop`, `reset`, `diagnostics`, `toGuestPath`/`toHostPath`. Détails : `lima/README.md`.
- **Mesures (Mac Apple Silicon, macOS 27, Ubuntu 26.04 LTS, 4 CPU / 4 Gio)** : premier lancement 9 min 04 s (image ~600 Mo + provisioning complet, connexion fibre) ; démarrage d'une VM provisionnée **5,9 s** ; changement de dossier **7,7 à 9,1 s** (arrêt 1,5 s + démarrage 6,5 s) : objectif < 15 s tenu.
- Tests : 69 unitaires (limactl simulé) + 10 d'intégration sur VM réelle (`ATELIER_SANDBOX_IT=1`, skippés en CI : pas de virtualisation imbriquée sur les runners) : boot, exec, écriture `/workspace` visible côté hôte, `/skills` en lecture seule, `$HOME` invisible, réseau bloqué → autorisé → rebloqué, SearXNG JSON sur `127.0.0.1:8888`, kill au délai, changement de dossier.
- **Skills** (`@atelier/skills`) : `loadSkills()` (frontmatter via gray-matter, skills invalides ignorés avec avertissement, descriptions bornées à 1024 caractères), `skillsPrompt()`, `installExampleSkills()`. Exemples : `xlsx` (script `build-workbook.cjs` : feuilles, formules avec résultats pré-calculés, totaux, graphiques Excel natifs colonne/barre/courbe/camembert) et `rapport-markdown` (structure, modèle, `csv_to_markdown.py`, conversion pandoc).
- Pour **Core** : l'outil `bash` doit appeler `sandbox.exec` ; `exec` rejette `agent/aborted` sur annulation et `sandbox/not_ready` si la VM n'est pas prête. Le prompt système peut inclure `skillsPrompt(await loadSkills(settings.skillsDir))`.
- Pour **UI / Lead** : instancier `new LimaSandbox({ limactlPath: <Resources>/lima/bin/limactl, templatesDir: <Resources>/lima-templates, skillsDir, resources, networkEnabled })` côté main ; appeler `stop()` à la fermeture. **À ajouter dans `electron-builder.yml`** : `packages/skills/examples` → `Contents/Resources/skills-examples` (pour `installExampleSkills` au premier lancement).
- Pour **MCP & Web** : SearXNG est disponible sur `http://127.0.0.1:8888/search?q=…&format=json` dès que la VM est prête (même si le réseau de `agent` est coupé).

## Web (agent MCP & Web, `feat/web-search-fetch`)

- **`@atelier/web`** : `createWebTools({ provider, fallbacks?, fetch? })` → `web_search` + `web_fetch` (`ToolDefinition`, à passer à `createDefaultRegistry`). Détails : `packages/web/README.md`.
- **`web_search`** (sans permission) : `createSearchProvider(id, { getApiKey, searxngUrl? })` pour `searxng` (défaut, `127.0.0.1:8888`), `ollama` (`POST ollama.com/api/web_search`, Bearer) et `brave` (`X-Subscription-Token`). Les clés sont lues à chaque recherche via `getApiKey` (l'app branche `safeStorage`). Si le fournisseur est indisponible (VM pas prête, clé absente) : essai des `fallbacks`, sinon message « Recherche indisponible, configure Brave ou Ollama dans les Réglages d'Atelier ».
- **`web_fetch`** (permission `conditional`, une fois par domaine : `scopeKey: web_fetch:<domaine>`, `kind: network`, redemandée si une redirection change de domaine, délai suspendu pendant la modale) : http(s) seulement, adresses non publiques refusées avant la requête, à chaque redirection et à la connexion TCP (lookup filtré d'undici, anti DNS rebinding), délai 20 s, 5 Mo max, Readability + jsdom → turndown, 20 ko max.
- Pour **UI / Lead** : `jsdom` et `undici` doivent rester externes au bundle du main (`externalizeDepsPlugin` d'electron-vite) ; `web_fetch` tourne dans le main uniquement. `SearxngProvider.isAvailable()` (via `/healthz`) peut alimenter l'indicateur des Réglages.
- ⚠️ `@types/jsdom` volontairement absent (déclaration locale `packages/web/src/types/jsdom.d.ts`) : jsdom étant un pair optionnel de Vitest, ses types injectaient `lib.dom` dans tous les packages (casse `scripts/fetch-lima.ts`).

## MCP (agent MCP & Web, `feat/mcp-bridge`)

- **`@atelier/mcp-bridge`** : `McpManager` (une instance dans le main) : `apply(await loadMcpConfig(path))` démarre les serveurs de `~/Atelier/mcp.json` (format Claude Desktop, stdio + streamable HTTP, lancés côté hôte), `status()`, `catalog()` / `definitions()`, `onChange()`, `stop()` à la fermeture. Détails : `packages/mcp-bridge/README.md`.
- Outils `mcp__<serveur>__<outil>` (`ToolDefinition`, schéma JSON → Zod) ; permission `never` si `readOnlyHint`, sinon `always` (`kind: mcp_write`, libellé « Utiliser « X » du connecteur Y »).
- **`tool_search({ query })`** par session : `registry.register(toolSearchTool({ source: mcp, registry }))` ; les outils trouvés sont enregistrés dans le registre de la session. `mcpPromptSection(mcp)` → `extraInstructions`.
- Reconnexion automatique (backoff 1 s → 30 s, 5 essais puis `failed`), reconnexion immédiate à l'appel d'un outil, `tools/list_changed` suivi, `stop()` termine les processus.
- Pour **UI / Lead** : après `mcp:write-config`, relire et `apply()` (seuls les serveurs modifiés redémarrent). Afficher `status()` (état, erreur avec fin de stderr) et `config.issues` dans les Réglages. Il faudra des canaux IPC pour l'état des connecteurs (type `McpServerStatus`, local à mcp-bridge pour l'instant : à promouvoir dans shared quand l'UI s'y branchera).
- ✅ **`lazyTools` livré dans agent-core** (PR `feat/core-lazy-tools`, implémenté par l'agent MCP & Web à la demande de Gilles, aucun changement de shared) : `AgentOptions.lazyTools?: () => readonly AnyToolDefinition[]` ; en début de tour, `tools` = registre ∪ `lazyTools()`, et `activeTools` = noms du registre, recalculés à chaque étape dans `prepareStep`. Un outil activé par `tool_search` est appelable dès l'étape suivante. L'app passe `lazyTools: () => mcp.definitions()`.

## UI desktop (agent UI, `feat/ui-shell`)

- **Process main branché** (PR `feat/ui-shell`) : `SettingsStore` (`userData/settings.json`, validation, écriture atomique), `SecretsStore` (`safeStorage`, `userData/secrets.json` en 0600, le renderer ne voit que la présence), `ServerMonitor` (sonde `/api/version`, repli `/v1/models` ; `connected` / `slow` > 1,5 s / `offline`, toutes les 30 s, 10 s hors ligne) → `llm:status`, « Tester la connexion » (latence, version, `/api/tags` ou `/v1/models`, contexte via `fetchContextWindow`).
- **Agent** : `ChatManager` (un tour à la fois par session, `agent:send` renvoie le `turnId` tout de suite, stop = annulation + refus des permissions ouvertes, `agent:retry` rejoue la dernière demande en échec avec l'historique d'avant) ; l'agent est recréé **à chaque tour** (`AgentFactory`, assemblage local en attendant la fabrique de Core) avec les réglages, la VM (dossier de la session monté, réseau de la session appliqué) et les skills courants ; le registre (natifs + web + `tool_search`) vit avec la session. `PermissionBroker` : modale ↔ `PermissionHandler`, `withSessionMemory` par session.
- **VM** : `SandboxManager` (démarrage en arrière-plan si l'onboarding est fait, `sandbox:progress` / `sandbox:status` relayés, réseau par session, `reset` relit CPU/RAM/skills des Réglages, arrêt à la fermeture). Sans `limactl` (dev sans `pnpm fetch:lima`) : état `error` avec un message clair, l'app fonctionne sans VM.
- **Fichiers** : `attachment:import` copie dans `<dossier>/.atelier/uploads/` (nom unique, 200 Mo max) ; `file:open` / `file:reveal` limités aux dossiers des sessions, et `file:open` refuse apps et scripts (`.app`, `.command`, `.sh`…).
- **Bundle** : `jsdom`, `undici` et les autres dépendances des packages sont externes au main (dépendances de `@atelier/desktop`). `electron-builder.yml` : `packages/skills/examples` → `Contents/Resources/skills-examples`. Historique en mémoire pour l'instant (`SessionStore`) : SQLite au lot 5.
- **Bascule sur la fabrique de Core** (PR `feat/ui-core-runtime`, après #15/#16) : `AgentRuntimeHost` remplace l'assemblage local : `createAgentRuntime` avec getters `sandbox` / `skills` / `extraInstructions`, `lazyTools: () => mcp.definitions()`, `tool_search` en `sessionTools`. Runtime recréé quand l'URL, le modèle, `numCtx`, le thinking ou le token changent ; chaque session agent porte la génération de son runtime et est recréée **entre deux tours** avec son historique. `refreshContextWindow()` est appelé quand le serveur repasse de hors ligne à joignable. `llm:test-connection` / `llm:list-models` / sonde : `testConnection`, `listModels`, `checkServerHealth` d'agent-core (seuil « lent » 2 s). L'historique modèle (`TurnResult.messages`) est persisté à côté des messages affichés (`SessionStore.saveModelHistory`), repli `chatMessagesToModelMessages`. Après #19 : passer `lastInputTokens` à la recréation.
- Limite connue : la VM ne monte qu'un dossier à la fois ; deux tours simultanés dans deux dossiers différents se gêneraient (le second remonte la VM). À traiter dans l'UI (un seul tour actif à la fois, ou file d'attente).
- Petit correctif dans `packages/web/src/fetch/extract.ts` (cast `as never` de la copie passée à Readability) : sous `lib.dom` (chargée par les types Electron), le type `DomNode` local n'était pas accepté.

## Demandes d'évolution de `packages/shared`

_Format : date, agent, type proposé, raison, packages impactés._

- ⏳ **2026-10-28, UI** (impact : `shared`, preload, renderer ; rien d'autre) :
  1. **`AtelierApi.getPathForFile(file: File): string`** (preload : `webUtils.getPathForFile`). Raison : glisser-déposer dans le chat ; depuis Electron 32 `File.path` n'existe plus et le renderer sandboxé ne peut pas obtenir le chemin autrement, or `attachment:import` attend des `hostPaths`. **Bloquant pour le lot 3 (chat).**
  2. **`'mcp:status'`** (invoke, `request: undefined`, `response: { servers: McpServerStatus[]; issues: McpConfigIssue[] }`) + event **`'mcp:status'`** (même charge), avec promotion de `McpServerStatus` / `McpConfigIssue` depuis mcp-bridge. Raison : état des connecteurs dans les Réglages (lot 5).
  3. **`'dialog:choose-directory'`** (`request: { title?: string; defaultPath?: string }`, `response: string | null`). Raison : choix du dossier des skills dans les Réglages ; `workspace:choose` est réservé au dossier de travail (il refuse `$HOME` et la racine).
  4. Codes d'erreur (confort) : `settings/invalid`, `session/not_found`, `agent/busy` (tour déjà en cours). En attendant : `internal` + `details.kind` (`invalid_settings`, `session_not_found`, `turn_in_progress`).

- ✅ **2026-10-28, acceptées par Gilles et le Lead (PR `feat/lead-shared-tool-contract`)**, les 4 demandes de Core du 2026-10-27 :
  1. `ToolOutput.denied?: boolean`, reporté dans `ToolResultEvent.denied`. → Core retire `ExecutedToolOutput`.
  2. `ToolDefinition.describePermission?(input): PermissionDescription` (nouveau type partagé `PermissionDescription` = `kind`, `title`, `detail?`, `scopeKey?`). Priorité : `describePermission` de l'outil, puis le describer d'agent-core, puis le repli générique. → mcp-bridge et web fournissent leurs libellés.
  3. Event `tool_display` `{ toolCallId, display }`, émis via `ToolExecutionContext.emitDisplay`. Le `display` de `tool_result` fait foi à la fin. → Core le branche, l'UI met à jour le bloc d'outil.
  4. Event `llm_retry` `{ attempt, maxAttempts?, delayMs, reason }` : « Reconnexion au serveur… » dans le chat du tour, sans toucher à `ServerStatus`. → Core le branche sur `onRetry`, l'UI l'affiche.

  ⚠️ `AgentEvent` gagne 2 membres : tout `switch` exhaustif sur `event.type` (UI, persistance) doit les traiter.

  ✅ **2026-10-28, adoptées par Core** (PR `feat/core-shared-adoption`) : types locaux retirés, libellés natifs portés par les outils, `tool_display` et `llm_retry` émis par la boucle (`llm_retry` rattaché au bon tour via `AsyncLocalStorage`, même avec plusieurs sessions sur un provider partagé).

- ✅ **2026-10-28, acceptée par le Lead (PR #7, mergée)** → Sandbox remplace `tool/path_outside_workspace` dans `assertMountableWorkspace`. ✅ Fait (PR `feat/sandbox-invalid-workspace`). 2026-10-27, Sandbox : code `sandbox/invalid_workspace` dans `ATELIER_ERROR_CODES`. Raison : `setWorkspace` refuse la racine, le `$HOME` complet, `LIMA_HOME` et le dossier des skills ; il utilise en attendant `tool/path_outside_workspace`, sémantiquement approximatif. Impact : `sandbox`, UI (traduction du message).

## Points ouverts / risques

- **MCP `readOnlyHint`** : annotation déclarée par le serveur, non vérifiable ; on fait confiance aux serveurs installés par l'utilisateur (voir README du bridge).

- `Caddyfile` validé syntaxiquement à la main seulement (pas de daemon Docker en local) : à valider au premier déploiement (`docker compose up -d && ./healthcheck.sh`).
- ✅ Repli vLLM côté Core (PR `feat/core-vllm-fallback`) : `listModels` / `testConnection` / `checkServerHealth` (agent-core) se rabattent sur `/v1/models` ; reste côté UI : brancher les canaux `llm:*` dessus.
- Signature et notarisation : nécessitent un certificat « Developer ID Application » et une clé API App Store Connect (`CSC_LINK`, `APPLE_API_KEY*`).
- Sandbox : le port hôte 8888 doit être libre (sinon Lima ne forwarde pas SearXNG ; à signaler dans les diagnostics). Le graphique Excel du skill `xlsx` est validé structurellement (schéma OOXML, xmllint, relecture exceljs) mais pas encore ouvert dans Excel : à faire par QA.
- Sandbox : règle réseau en `reject` plutôt que `drop` (même blocage, échec immédiat au lieu d'un blocage de l'agent jusqu'au délai) ; le DNS et SearXNG sont aussi coupés pour `agent` quand le réseau est désactivé (pas d'exfiltration par requête DNS ou recherche).

## Notes de Core (agent-core)

- **AI SDK v7, renommages à connaître** : `system` → `instructions`, `fullStream` → `stream`, `experimental_repairToolCall` → `repairToolCall`, `stepCountIs` (alias de `isStepCount`), `result.response.messages` → `result.responseMessages`, mock `MockLanguageModelV4` (`ai/test`, chunks V4 : `usage.inputTokens.total`, `finishReason.unified`).
- **API** : `createLlmModels` + `fetchContextWindow` + `new Agent({...})` + `AgentSession.send(input, emit, signal)` ; détails dans `packages/agent-core/README.md`. `runTurn` ne lève jamais : erreurs → event `error`.
- **Chemins** : `resolveWorkspacePath(workspace, path)` (export d'agent-core) pour `packages/documents` ; gère le dossier de travail derrière un symlink (`/var` → `/private/var` sur macOS) et refuse tout symlink sortant.
- **Thinking off** : `reasoning_effort: "none"` (Ollama) + `chat_template_kwargs.enable_thinking: false` (vLLM). Le raisonnement est retiré de l'historique, y compris entre deux étapes d'un même tour (`prepareStep`).
- **Contexte** : `/api/show` → `num_ctx` du Modelfile ; sans `num_ctx`, hypothèse 32 768 (bornée par le max du modèle) car `OLLAMA_CONTEXT_LENGTH` n'est pas lisible à distance : d'où l'intérêt du Modelfile `atelier`. Repli vLLM : `/v1/models` (`max_model_len`).
- **Fabrique `createAgentRuntime`** (PR `feat/core-agent-factory`) pour le main Electron : LLM + fenêtre de contexte (sans lever si le serveur est hors ligne), `createSession({ sessionId, workspace, requestPermission, history })` avec un registre par session (`tools`, `sessionTools` pour `tool_search`, `lazyTools`). `AgentOptions.sandbox`, `skills` et `extraInstructions` acceptent un getter relu à chaque tour (VM prête après création de la session) ; `session.send(..., { turnId })` pour un identifiant de tour fourni par l'app. Persister `TurnResult.messages` pour la reprise de session. API convenue avec l'agent UI.
- **`LocalSandbox`** (M1) exécute `bash` sur l'hôte **sans isolation** : CLI de démo uniquement, à remplacer par `packages/sandbox` dans l'app.

## Comportements du modèle observés

_Validation manuelle Core, 2026-10-27 : Ollama 0.40.11 local (Apple Silicon), CLI `agent-core`, 5 scénarios (synthèse multi-fichiers, édition ciblée, refus de permission, tentative de sortie du dossier, plan en 3 livrables) + compaction forcée (`--num-ctx 3500`). Modèles : `qwen3.5:35b` et `qwen3.5:9b`, thinking on/off ; `qwen3.6:35b-a3b` en complément._

**Ce qui marche bien (35b et 9b)**

- Tool calling natif fiable via `/v1` : aucun appel écrit en texte, aucune réparation nécessaire sur ces scénarios (le repli et `repairToolCall` restent couverts par les tests).
- `edit_file` : `old_str` unique du premier coup (ligne entière recopiée). Refus de permission respecté : le modèle s'arrête et propose des alternatives. Sortie du dossier : refus de `read_file`, pas d'insistance.
- `todo_write` bien utilisé sur les demandes en plusieurs livrables (une tâche `in_progress` à la fois) ; `present_file` en fin de tâche.
- Thinking : le raisonnement arrive dans `delta.reasoning` (Ollama) → `reasoning_delta` ; `reasoning_effort: "none"` le coupe bien (0 raisonnement émis).
- Compaction : déclenchée à 78 % ; après résumé, le modèle retrouve encore les faits clés (présents, client Dupont SA).
- Latences (Mac local) : 9b ≈ 4-15 s par scénario simple, 35b ≈ 3-22 s ; plan en 3 livrables : 25-40 s.

**Comportements problématiques**

1. **Données inventées (35b, thinking on)** : sur « 3 livrables, organise-toi », le modèle a rédigé les fichiers sans lire `notes-reunion.md` ni le CSV (gammes et dates inventées). Corrigé par une consigne explicite du prompt système (« lis les fichiers avant de rédiger, n'invente jamais de chiffres… ») : 2 exécutions sur 2 correctes ensuite. **À surveiller en QA.**
2. **Arithmétique sans thinking (9b)** : total T3 faux (67 923 € au lieu de 67 921 €) alors que les sous-totaux sont justes. Avec thinking : juste. → Recommandation UI : thinking activé par défaut, ou inciter au calcul via `bash`/Python dès que la VM est là.
3. **Appel d'outil vide** (35b) : `write_file {}` une fois, rejeté par la validation Zod puis corrigé par le modèle à l'étape suivante (coût : une étape).
4. **Contournement d'un échec** (`qwen3.6`, avant correctif) : quand `write_file` échouait (gestionnaire de permission en erreur), le modèle a tenté 15 fois, dont `bash cat > fichier`, et après le refus d'un chemin hors dossier il a sondé `../../..` et `find /private/tmp` via bash. Corrigé côté Core : erreur du gestionnaire = refus, message de refus « ni par un autre moyen », liste blanche bash fermée aux chemins hors `/workspace`. **Ne jamais livrer `LocalSandbox` dans l'app** : seule la VM borne réellement `bash`.
5. **Raisonnement en anglais** par moments (35b, qwen3.6) alors que la réponse est en français : sans gravité (affiché à part), mais visible dans l'UI.
6. **Petites fautes en français** sur le 9b (« d' vous », « Échéation », « décissions ») et noms de fichiers parfois accentués à tort dans la réponse (« synthèse.md » pour `synthese.md`). Le 35b est nettement plus propre.
7. **Détours bizarres** : écrire `tableau_ventes.mdtmp` puis `mv` via bash ; `todo_write {"todos": []}` en fin de tâche (vide la liste affichée). Sans conséquence, mais l'UI devrait garder la dernière liste non vide visible.
8. **Coût fixe du contexte** : prompt système + 9 définitions d'outils ≈ 2 300 tokens avant le premier message. Avec MCP, prévoir `tool_search` (activation paresseuse) comme prévu au brief.
