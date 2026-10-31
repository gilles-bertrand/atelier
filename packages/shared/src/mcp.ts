/** État des connecteurs MCP, pour les Réglages et les diagnostics. */

/** État d'un serveur MCP. */
export type McpServerState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped';

/** Transport d'un serveur MCP : processus local (`stdio`) ou streamable HTTP. */
export type McpTransportKind = 'stdio' | 'http';

/** Instantané d'un serveur (Réglages, diagnostics). */
export interface McpServerStatus {
  /** Nom du serveur (clé de `mcpServers` dans `mcp.json`). */
  name: string;
  transport: McpTransportKind;
  state: McpServerState;
  /** Nombre d'outils publiés. */
  toolCount: number;
  /** Nom et version annoncés par le serveur. */
  serverInfo?: { name: string; version: string };
  /** Dernière erreur lisible (avec la fin de stderr pour un serveur stdio). */
  error?: string;
  /** Tentatives de reconnexion consécutives. */
  reconnectAttempts: number;
  /** Outils publiés par le serveur (absent tant que le serveur n'est pas connecté). */
  tools?: McpToolInfo[];
}

/** Outil publié par un serveur MCP (choix outil par outil des tâches planifiées, ADR-002 D4). */
export interface McpToolInfo {
  /** Nom complet `mcp__<serveur>__<outil>` : la `scopeKey` des demandes de permission. */
  name: string;
  /** Titre lisible annoncé par le serveur. */
  title?: string;
  /**
   * `readOnlyHint` du serveur : déclaratif, non vérifiable. Un outil en lecture
   * ne demande pas de permission ; seuls les autres se cochent dans le formulaire.
   */
  readOnly: boolean;
}

/** Problème de configuration d'un serveur dans `mcp.json` (serveur ignoré). */
export interface McpConfigIssue {
  /** Nom du serveur concerné. */
  server: string;
  /** Message en français. */
  message: string;
}

/** État global des connecteurs MCP. */
export interface McpStatus {
  servers: McpServerStatus[];
  issues: McpConfigIssue[];
}
