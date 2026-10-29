# @atelier/agent-core

Boucle agentique d'Atelier (Vercel AI SDK v7), outils natifs, permissions, compaction. Spécification : `docs/BRIEF.md` §1 et §2.

## Démo en CLI

```bash
# Serveur local (http autorisé pour localhost / Tailscale) :
pnpm --filter agent-core dev -- --dir ./demo
# Serveur distant derrière Caddy :
ATELIER_LLM_URL=https://llm.example.com ATELIER_LLM_TOKEN=… \
  pnpm --filter agent-core dev -- --dir ./demo --model qwen3.5:9b --no-thinking
# Un seul message, permissions acceptées, journal de diagnostic :
pnpm --filter agent-core dev -- --dir ./demo -p "Résume notes-reunion.md" --yes -v
```

`./demo` (relatif à `packages/agent-core`) contient deux fichiers d'exemple ; ce que l'agent y produit n'est pas suivi par git. ⚠️ En M1, `bash` tourne **sans isolation** sur la machine (`LocalSandbox`) : `--no-bash` pour le couper.

## Fabrique pour le process main (`createAgentRuntime`)

La façon recommandée de brancher l'agent dans Electron. agent-core ne dépend pas de `web`, `mcp-bridge`, `skills` ni `sandbox` : l'app construit leurs instances et les passe.

```ts
import { createAgentRuntime } from '@atelier/agent-core';

// Au démarrage, puis à chaque changement des Réglages LLM. Ne lève que pour une URL invalide :
// serveur injoignable → contextWindowSource 'fallback' (32 768, ou numCtx), à rafraîchir plus tard.
const runtime = await createAgentRuntime({
  llm: { baseUrl, model, token, thinking, numCtx },
  tools: [...createWebTools(webOptions), ...documentsTools], // remplacent un natif de même nom (outils de l'app uniquement)
  sessionTools: (registry) => [toolSearchTool({ source: mcp, registry })], // registre de LA session
  lazyTools: () => mcp.definitions(),
  sandbox: () => (vmReady ? lima : undefined), // relu à chaque tour
  skills: () => skills, // tableau ou getter
  extraInstructions: () => mcpPromptSection(mcp),
  log,
});
await runtime.refreshContextWindow(); // quand le serveur revient

const session = runtime.createSession({
  sessionId,
  workspace,
  requestPermission, // withSessionMemory appliqué par session
  history, // TurnResult.messages persistés (repli : chatMessagesToModelMessages)
});
const turnId = randomUUID();
const result = await session.send(text, emit, abort.signal, { turnId });
persist(result.messages); // historique modèle fidèle (compaction, paires outil/résultat)

// Réglages LLM modifiés : nouveau runtime, sessions ouvertes recréées sans perdre la compaction
const replaced = newRuntime.createSession({
  sessionId,
  workspace,
  requestPermission,
  history: session.history,
  ...(session.lastInputTokens !== undefined ? { lastInputTokens: session.lastInputTokens } : {}),
});
```

## Intégration manuelle (process main)

```ts
import {
  Agent,
  AgentSession,
  chatMessagesToModelMessages,
  createDefaultRegistry,
  createLlmModels,
  fetchContextWindow,
} from '@atelier/agent-core';

const llm = createLlmModels({ baseUrl, model, token, thinking: settings.llm.thinking });
const { contextWindow } = await fetchContextWindow({
  baseUrl,
  model,
  token,
  override: settings.llm.numCtx,
});
const agent = new Agent({
  model: llm.model,
  fastModel: llm.fastModel, // résumés de compaction (thinking coupé)
  registry, // createDefaultRegistry([...documentsTools, ...webTools]) + tool_search (mcp-bridge)
  lazyTools: () => mcp.definitions(), // outils MCP, actifs une fois activés par tool_search
  workspace, // dossier choisi par l'utilisateur
  requestPermission, // ouvre la modale, mémorise les allow_session
  sandbox, // packages/sandbox (Lima) ; absent → bash répond « VM indisponible »
  contextWindow,
  skills,
  serverUrl: baseUrl,
});
const session = new AgentSession(agent, sessionId, chatMessagesToModelMessages(persisted));
const result = await session.send(
  userText,
  (event) => webContents.send('agent:event', event),
  abortSignal,
);
```

- `runTurn` / `send` **ne lèvent jamais** : toute erreur devient un event `error` (`SerializedAtelierError`), sinon le tour finit par `done` (`stop` | `aborted` | `max_steps` | `length`).
- Events émis : `text_delta`, `reasoning_delta` (thinking, jamais réinjecté), `tool_start`, `tool_display` (affichage publié pendant l'outil via `emitDisplay`), `tool_result` (`denied` si refus ; son `display` fait foi), `todo_update`, `permission_request` (émis juste avant l'appel au `PermissionHandler`), `sources`, `llm_retry` (nouvelle tentative réseau, rattachée au tour), `compaction`, `done`, `error`.
- `lazyTools` (optionnel) : outils déclarés à l'AI SDK en début de tour mais inactifs (`activeTools`) tant qu'ils ne sont pas dans le registre. `activeTools` est recalculé à chaque étape (`prepareStep`) : un outil enregistré pendant le tour (par `tool_search`) est appelable dès l'étape suivante. Un outil du registre prime sur un outil paresseux de même nom ; un outil inactif appelé quand même est refusé avant toute demande de permission. Le prompt système ne liste que le registre.
- Si le modèle rend la main (`stop`) alors que sa liste `todo_write` du tour contient encore des tâches `pending`, la boucle le relance (au plus `MAX_CONTINUATIONS` = 2 fois, jamais s'il termine par une question). La relance est un message utilisateur `[Atelier] …` ajouté à l'historique modèle, sans event dédié : l'UI voit simplement le tour continuer.
- `result.messages` est l'historique modèle à conserver pour le tour suivant (raisonnement retiré, compaction appliquée).

### Serveur LLM (Réglages, onboarding, indicateur)

Trois fonctions prêtes pour les canaux IPC `llm:*`, compatibles Ollama **et** vLLM (repli sur `GET /v1/models` quand `/api/tags`, `/api/version` ou `/api/show` répondent 404, voir `docs/SERVER.md` §5) :

```ts
import { checkServerHealth, listModels, testConnection } from '@atelier/agent-core';

// 'llm:test-connection' : ne lève jamais, l'échec est dans { ok: false, errorCode, errorMessage }
await testConnection({ baseUrl, token, model, numCtx: settings.llm.numCtx });
// 'llm:list-models' : lève une AtelierError (llm/unauthorized, llm/unreachable…)
const { models, flavor } = await listModels({ baseUrl, token }); // flavor : 'ollama' | 'openai-compatible'
// 'llm:status' (sondage périodique) : connected / slow (> 2 s) / offline, ne lève jamais
await checkServerHealth({ baseUrl, token });
```

## Contenu

| Module                    | Rôle                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loop/agent.ts`           | `Agent.runTurn` : `streamText` + `stopWhen: stepCountIs(50)` + `abortSignal`, mapping du `stream` (ex-`fullStream`) vers `AgentEvent`. `AgentSession` garde l'historique.                                                                             |
| `llm/provider.ts`         | `createOpenAICompatible` vers `<url>/v1`, Bearer, thinking on/off (`reasoning_effort: "none"` + `chat_template_kwargs.enable_thinking`), middlewares.                                                                                                 |
| `llm/retry-fetch.ts`      | Nouvelles tentatives avec backoff exponentiel + gigue (réseau, 429, 502-504, `Retry-After`).                                                                                                                                                          |
| `llm/context-window.ts`   | Contexte réel via `/api/show` (`num_ctx`), repli vLLM `/v1/models`.                                                                                                                                                                                   |
| `llm/server.ts`           | `listModels`, `testConnection`, `checkServerHealth` : Ollama, repli vLLM `/v1/models`.                                                                                                                                                                |
| `llm/errors.ts`           | Erreurs explicites : `llm/unreachable`, `llm/unauthorized`, `llm/model_not_found`, `llm/timeout`…                                                                                                                                                     |
| `loop/repair.ts`          | `repairToolCall` : nom d'outil approximatif, JSON abîmé, arguments enveloppés.                                                                                                                                                                        |
| `loop/text-tool-calls.ts` | Middleware de repli : appels écrits dans le texte (`<tool_call>`, XML Qwen, JSON) → vrais appels, seulement en tête de réponse (court préambule, hors bloc de code) et jamais pour un appel recopié d'un résultat d'outil ou d'un message (brief §8). |
| `loop/compaction.ts`      | Au-delà de 75 % du contexte : réduit d'abord les anciens résultats d'outils (appels gardés, dernière étape protégée), puis résume les tours précédents. La demande du tour en cours n'est jamais résumée.                                             |
| `loop/budget.ts`          | Budget de contexte par étape : une sortie d'outil ≤ 25 % de la fenêtre, une étape ≤ 50 % (moins si la fenêtre est pleine), troncature expliquée au modèle. `num_ctx` est un plafond, pas une garantie (runner MLX).                                   |
| `prompt/system-prompt.ts` | Prompt système généraliste (rôle, dossier, date, skills, sécurité, recherche web).                                                                                                                                                                    |
| `paths.ts`                | `resolveWorkspacePath` : vérification stricte des chemins, symlinks compris (réutilisé par `documents`).                                                                                                                                              |
| `tools/*`                 | `read_file` (texte, M1), `write_file`, `edit_file`, `list_dir` (signale les pièces jointes de `.atelier/uploads`), `glob`, `grep`, `todo_write`, `present_file`, `bash`, adaptateur registre → `tools` AI SDK.                                        |
| `runtime.ts`              | `createAgentRuntime` : LLM + contexte une fois, puis `createSession` (registre par session, permissions mémorisées).                                                                                                                                  |
| `local-sandbox.ts`        | `Sandbox` temporaire via `child_process` (M1, sans isolation).                                                                                                                                                                                        |

## Permissions

- `permission: 'always'` : l'adaptateur (`executeTool`) demande l'accord avant `execute`. Libellé, par priorité : `describePermission` de l'outil (shared), puis `AgentOptions.describePermission` (peut renvoyer `undefined`), puis le repli générique « Utiliser l'outil … ». Les outils natifs fournissent le leur.
- `permission: 'conditional'` : l'outil décide (`bash` hors liste blanche `ls`, `cat`, `head`, `grep`, `wc`… sans redirection ni chaînage).
- Un refus renvoie au modèle « L'utilisateur a refusé l'action … », jamais une exception.
