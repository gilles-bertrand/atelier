# STATUS : Atelier

**Squelette prêt, les agents peuvent démarrer.**

_Dernière mise à jour : 2026-10-27, Lead._

## État par jalon

| Jalon                                                       | État          | Responsable(s)                |
| ----------------------------------------------------------- | ------------- | ----------------------------- |
| M0 : squelette monorepo + `packages/shared` + `server/`     | ✅ fait       | Lead                          |
| M1 : boucle AI SDK en CLI, outils fichiers, bash local, web | ⏳ à démarrer | Core, MCP & Web               |
| M2 : sandbox Lima + permissions                             | ⏳ à démarrer | Sandbox                       |
| M3 : app Electron fonctionnelle                             | ⏳ à démarrer | UI                            |
| M4 : skills + MCP + SearXNG + documents                     | ⏳ à démarrer | Sandbox, MCP & Web, Documents |
| M5 : historique, compaction, réglages, packaging signé      | ⏳            | UI, Core, Lead                |

## Ce que contient le squelette

- Monorepo pnpm 11 (`apps/*`, `packages/*`), TypeScript 6 strict partagé (`tsconfig.base.json`), ESLint 10 (`strictTypeChecked`, `no-explicit-any`), Prettier, Vitest 5 (projets par package).
- `packages/shared` : erreurs typées (`AtelierError`), messages de chat, `ToolDefinition` / `defineTool` / `ToolRegistry` (+ `InMemoryToolRegistry`), `AgentEvent` (text_delta, reasoning_delta, tool_start, tool_result, todo_update, permission_request, sources, compaction, done, error), contrats IPC (`IpcInvokeContract`, `IpcEventContract`, `AtelierApi`), interfaces `Sandbox`, `SearchProvider`, `PermissionHandler`, réglages, config LLM, et `checkServerUrl` (https obligatoire hors localhost/Tailscale).
- Packages vides compilables : `agent-core`, `sandbox`, `skills`, `mcp-bridge`, `web`, `documents`.
- `apps/desktop` : Electron 45 + electron-vite 6 + React 19 + Tailwind 4 + shadcn/ui (Button, `cn`, thème neutral), preload `sandbox: true` avec liste blanche des canaux IPC, CSP stricte en production. L'app démarre sur un écran vide (vérifié en local).
- `apps/desktop/electron-builder.yml` : mac arm64 (dmg + zip), hardened runtime, notarisation via variables d'env.
- `server/` : `docker-compose.yml` (Ollama GPU NVIDIA + Caddy), `Caddyfile` (TLS, Bearer, rate limit, liste blanche des routes), `Modelfile` `atelier`, `.env.example`, `healthcheck.sh`. Documentation : `docs/SERVER.md`.
- CI GitHub Actions (`macos-14`) : format, lint, typecheck, test, build.

## Notes du Lead pour les agents

- **AI SDK v7** (et non v5) : `tool({ description, inputSchema, execute })` et `streamText` sont inchangés ; le mock de test est `MockLanguageModelV4` (`ai/test`).
- Les outils se définissent avec `defineTool` (`@atelier/shared`) ; `agent-core` les convertit en outils AI SDK en injectant `ToolExecutionContext`.
- `ToolExecutionContext.sandbox` est optionnel (VM pas encore prête) : les outils doivent dégrader proprement.
- Les packages sont consommés en source TS (pas de build par package) ; electron-vite les bundle.
- Pour les dépendances natives (`better-sqlite3`, `sharp`), l'autorisation des scripts d'installation se fait dans `pnpm-workspace.yaml` (`allowBuilds`) : demandez au Lead.

## Demandes d'évolution de `packages/shared`

_Format : date, agent, type proposé, raison, packages impactés._

- (aucune)

## Points ouverts / risques

- `Caddyfile` validé syntaxiquement à la main seulement (pas de daemon Docker en local) : à valider au premier déploiement (`docker compose up -d && ./healthcheck.sh`).
- Repli vLLM : `/api/tags` et `/api/show` n'existent pas dans vLLM, d'où un repli sur `/v1/models` à prévoir (Core + UI), voir `docs/SERVER.md` §5.
- Le dépôt n'a pas encore de remote GitHub : la CI et les PR démarrent dès que le remote est créé.
- Signature et notarisation : nécessitent un certificat « Developer ID Application » et une clé API App Store Connect (`CSC_LINK`, `APPLE_API_KEY*`).

## Comportements du modèle observés

_(à compléter par Core / QA : qwen3.5:35b, qwen3.5:9b)_
