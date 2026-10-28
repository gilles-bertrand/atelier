# STATUS : Atelier

**Squelette prêt, les agents peuvent démarrer.**

_Dernière mise à jour : 2026-10-28, Lead._

## État par jalon

| Jalon                                                       | État                                                   | Responsable(s)                |
| ----------------------------------------------------------- | ------------------------------------------------------ | ----------------------------- |
| M0 : squelette monorepo + `packages/shared` + `server/`     | ✅ fait                                                | Lead                          |
| M1 : boucle AI SDK en CLI, outils fichiers, bash local, web | 🟡 Core livré (PR `feat/core-agent-loop`), web à venir | Core, MCP & Web               |
| M2 : sandbox Lima + permissions                             | ⏳ à démarrer                                          | Sandbox                       |
| M3 : app Electron fonctionnelle                             | ⏳ à démarrer                                          | UI                            |
| M4 : skills + MCP + SearXNG + documents                     | ⏳ à démarrer                                          | Sandbox, MCP & Web, Documents |
| M5 : historique, compaction, réglages, packaging signé      | ⏳                                                     | UI, Core, Lead                |

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

## Demandes d'évolution de `packages/shared`

_Format : date, agent, type proposé, raison, packages impactés._

- ✅ **2026-10-28, acceptées par Gilles et le Lead (PR `feat/lead-shared-tool-contract`)**, les 4 demandes de Core du 2026-10-27 :
  1. `ToolOutput.denied?: boolean`, reporté dans `ToolResultEvent.denied`. → Core retire `ExecutedToolOutput`.
  2. `ToolDefinition.describePermission?(input): PermissionDescription` (nouveau type partagé `PermissionDescription` = `kind`, `title`, `detail?`, `scopeKey?`). Priorité : `describePermission` de l'outil, puis le describer d'agent-core, puis le repli générique. → mcp-bridge et web fournissent leurs libellés.
  3. Event `tool_display` `{ toolCallId, display }`, émis via `ToolExecutionContext.emitDisplay`. Le `display` de `tool_result` fait foi à la fin. → Core le branche, l'UI met à jour le bloc d'outil.
  4. Event `llm_retry` `{ attempt, maxAttempts?, delayMs, reason }` : « Reconnexion au serveur… » dans le chat du tour, sans toucher à `ServerStatus`. → Core le branche sur `onRetry`, l'UI l'affiche.

  ⚠️ `AgentEvent` gagne 2 membres : tout `switch` exhaustif sur `event.type` (UI, persistance) doit les traiter.

  ✅ **2026-10-28, adoptées par Core** (PR `feat/core-shared-adoption`) : types locaux retirés, libellés natifs portés par les outils, `tool_display` et `llm_retry` émis par la boucle (`llm_retry` rattaché au bon tour via `AsyncLocalStorage`, même avec plusieurs sessions sur un provider partagé).

## Points ouverts / risques

- `Caddyfile` validé syntaxiquement à la main seulement (pas de daemon Docker en local) : à valider au premier déploiement (`docker compose up -d && ./healthcheck.sh`).
- Repli vLLM : `/api/tags` et `/api/show` n'existent pas dans vLLM, d'où un repli sur `/v1/models` à prévoir (Core + UI), voir `docs/SERVER.md` §5.
- Signature et notarisation : nécessitent un certificat « Developer ID Application » et une clé API App Store Connect (`CSC_LINK`, `APPLE_API_KEY*`).

## Notes de Core (agent-core)

- **AI SDK v7, renommages à connaître** : `system` → `instructions`, `fullStream` → `stream`, `experimental_repairToolCall` → `repairToolCall`, `stepCountIs` (alias de `isStepCount`), `result.response.messages` → `result.responseMessages`, mock `MockLanguageModelV4` (`ai/test`, chunks V4 : `usage.inputTokens.total`, `finishReason.unified`).
- **API** : `createLlmModels` + `fetchContextWindow` + `new Agent({...})` + `AgentSession.send(input, emit, signal)` ; détails dans `packages/agent-core/README.md`. `runTurn` ne lève jamais : erreurs → event `error`.
- **Chemins** : `resolveWorkspacePath(workspace, path)` (export d'agent-core) pour `packages/documents` ; gère le dossier de travail derrière un symlink (`/var` → `/private/var` sur macOS) et refuse tout symlink sortant.
- **Thinking off** : `reasoning_effort: "none"` (Ollama) + `chat_template_kwargs.enable_thinking: false` (vLLM). Le raisonnement est retiré de l'historique, y compris entre deux étapes d'un même tour (`prepareStep`).
- **Contexte** : `/api/show` → `num_ctx` du Modelfile ; sans `num_ctx`, hypothèse 32 768 (bornée par le max du modèle) car `OLLAMA_CONTEXT_LENGTH` n'est pas lisible à distance : d'où l'intérêt du Modelfile `atelier`. Repli vLLM : `/v1/models` (`max_model_len`).
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
