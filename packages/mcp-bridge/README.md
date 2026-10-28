# @atelier/mcp-bridge

Connecteurs MCP d'Atelier (brief §6) : serveurs lancés côté hôte (stdio) ou distants (streamable HTTP), outils exposés comme `ToolDefinition` nommées `mcp__<serveur>__<outil>`, chargés à la demande par `tool_search`.

## Branchement dans l'app (process main)

```ts
import { McpManager, loadMcpConfig, mcpPromptSection, toolSearchTool } from '@atelier/mcp-bridge';

// Une instance pour toute l'app.
const mcp = new McpManager({ log });
await mcp.apply(await loadMcpConfig(settings.mcpConfigPath)); // ne rejette jamais (sauf JSON illisible côté loadMcpConfig)
app.on('before-quit', () => void mcp.stop()); // termine les processus des serveurs

// Après `mcp:write-config` : relire et appliquer (seuls les serveurs modifiés redémarrent).
await mcp.apply(await loadMcpConfig(settings.mcpConfigPath));

// Par session : tool_search active les outils dans le registre de la session.
const registry = createDefaultRegistry([...webTools]);
registry.register(toolSearchTool({ source: mcp, registry }));
const agent = new Agent({
  registry,
  lazyTools: () => mcp.definitions(), // activables dans le même tour
  extraInstructions: mcpPromptSection(mcp),
  // ...
});
```

Réglages : `mcp.status()` (état, nombre d'outils, erreur avec la fin de stderr) et `mcp.config.issues` (serveurs ignorés car invalides) ; `mcp.onChange(cb)` pour rafraîchir l'affichage.

## `mcp.json` (format Claude Desktop)

```json
{
  "mcpServers": {
    "fichiers": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]
    },
    "notion": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    },
    "ancien": { "command": "node", "args": ["serveur.js"], "disabled": true }
  }
}
```

- stdio : `command`, `args`, `env`, `cwd` (`~` développé dans `command` et `cwd`). Environnement : variables sûres du SDK (`getDefaultEnvironment`), PATH complété par `/opt/homebrew/bin` et `/usr/local/bin` (une app lancée depuis le Finder n'a pas Homebrew dans son PATH), puis `env`.
- HTTP : `url` (https, ou http seulement sur localhost), `headers`. `"type": "sse"` est refusé avec un message clair.
- Un serveur invalide est ignoré (`config.issues`) sans bloquer les autres ; un fichier absent = aucun connecteur.

## Outils

- **Nom** : `mcp__<serveur>__<outil>` (`mcpToolName` de shared ; collision après normalisation : le premier gagne).
- **Schéma** : JSON Schema MCP → Zod (`z.fromJSONSchema`) ; si la conversion échoue (`$ref`…), le JSON Schema d'origine est transmis tel quel (métadonnée Zod) et le serveur valide.
- **Permission** : `never` si `annotations.readOnlyHint: true`, sinon `always` (toute écriture MCP demande l'accord ; pas d'annotation = écriture). ⚠️ `readOnlyHint` est déclaré par le serveur lui-même, donc non vérifiable : un serveur que l'utilisateur a installé dans `mcp.json` est considéré digne de confiance pour ses annotations (un serveur malveillant pourrait marquer une écriture en lecture seule). Libellé : « Utiliser « <titre> » du connecteur <serveur> », `kind: mcp_write`, `scopeKey` = nom de l'outil.
- **Résultat** : textes et ressources texte concaténés (images, audio, binaires signalés mais non transmis), `structuredContent` à défaut, tronqué à 25 000 caractères ; `isError` → `ok: false`. Une erreur de transport devient `ok: false`, jamais une exception (sauf annulation du tour).
- `toDynamicTool(entry, call)` : variante AI SDK brute (`dynamicTool` + `jsonSchema`) pour un usage hors agent-core, **sans** politique de permission.

## `tool_search({ query })`

Classe le catalogue (nom de l'outil ×3, serveur ×2, titre ×2, description ×1 ; préfixes, accents et camelCase gérés ; bonus si tous les mots sont couverts ; nom exact prioritaire) et enregistre jusqu'à 8 outils dans le registre de la session. Le modèle reçoit la liste des outils activés avec leurs paramètres. Sans connecteur ou sans résultat : message explicite avec l'état des connecteurs.

Avec `AgentOptions.lazyTools: () => mcp.definitions()` (agent-core), un outil activé par `tool_search` est appelable dès l'étape suivante du même tour. Sans cette option, il ne l'est qu'au tour suivant.

## Cycle de vie et erreurs

`connecting` → `connected` ; processus mort ou transport fermé → `reconnecting` (délai exponentiel 1 s → 30 s) → `failed` après 5 tentatives. Un appel d'outil sur un serveur tombé tente une reconnexion immédiate. `notifications/tools/list_changed` met le catalogue à jour. `stop()` ferme chaque client (le SDK termine le processus enfant), avec un délai de 5 s.

## Tests

`pnpm --filter @atelier/mcp-bridge test` : intégration contre le vrai `@modelcontextprotocol/server-filesystem` (stdio : catalogue, permissions, `tool_search`, lecture/écriture, reconnexion après `SIGKILL`, arrêt du processus), serveur streamable HTTP local (en-têtes, appel), transport en mémoire (`list_changed`, échec puis reconnexion à la demande, rechargement de config).
