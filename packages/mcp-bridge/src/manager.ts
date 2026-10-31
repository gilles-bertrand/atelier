/**
 * Gestionnaire des serveurs MCP de l'app : démarrage depuis `mcp.json`,
 * rechargement à chaud, catalogue des outils, appels, arrêt propre.
 *
 * Une seule instance par app (process main), partagée par toutes les sessions :
 * chaque session active ses outils via `tool_search` (voir `search.ts`).
 */
import { AtelierError, type AnyToolDefinition } from '@atelier/shared';
import type { McpConfig, McpServerConfig } from './config.js';
import { McpConnection, type McpConnectionOptions, type McpServerStatus } from './connection.js';
import {
  toCatalogEntry,
  type McpCallResult,
  type McpCatalogEntry,
  type McpToolInfo,
} from './tools.js';

/** Options du gestionnaire (transmises à chaque connexion). */
export type McpManagerOptions = Omit<McpConnectionOptions, 'onChange'>;

function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Gestionnaire des connexions MCP. */
export class McpManager {
  readonly #options: McpManagerOptions;
  readonly #connections = new Map<string, McpConnection>();
  readonly #listeners = new Set<() => void>();
  /** Catalogue mis en cache par serveur, recalculé quand sa liste d'outils change. */
  readonly #catalogCache = new Map<
    string,
    { tools: readonly McpToolInfo[]; entries: McpCatalogEntry[] }
  >();
  #config: McpConfig = { servers: [], disabled: [], issues: [] };

  constructor(options: McpManagerOptions = {}) {
    this.#options = options;
  }

  /** Configuration courante (problèmes de config compris, pour les Réglages). */
  get config(): McpConfig {
    return this.#config;
  }

  /**
   * Applique une configuration : arrête les serveurs retirés ou modifiés, démarre
   * les nouveaux. Se résout quand chaque nouveau serveur est connecté ou a
   * échoué à sa première tentative (jamais de rejet).
   */
  async apply(config: McpConfig): Promise<void> {
    this.#config = config;
    const wanted = new Map(config.servers.map((s) => [s.name, s]));
    const stopping: Promise<void>[] = [];
    for (const [name, connection] of this.#connections) {
      const next = wanted.get(name);
      if (!next || !sameConfig(next, connection.config)) {
        this.#connections.delete(name);
        this.#catalogCache.delete(name);
        stopping.push(connection.stop());
      }
    }
    await Promise.all(stopping);
    const starting: Promise<void>[] = [];
    for (const server of config.servers) {
      if (this.#connections.has(server.name)) continue;
      const connection = new McpConnection(server, {
        ...this.#options,
        onChange: () => {
          this.#emit();
        },
      });
      this.#connections.set(server.name, connection);
      starting.push(connection.start());
    }
    this.#emit();
    await Promise.all(starting);
  }

  /** Arrête tous les serveurs (à appeler à la fermeture de l'app). */
  async stop(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    this.#catalogCache.clear();
    await Promise.all(connections.map((c) => c.stop()));
    this.#emit();
  }

  /**
   * État de chaque serveur configuré. Un serveur connecté liste aussi ses outils
   * (`tools`, choix outil par outil des tâches planifiées, ADR-002 D4).
   */
  status(): McpServerStatus[] {
    return [...this.#connections.values()].map((connection) => {
      const status = connection.status();
      if (connection.state !== 'connected') return status;
      return {
        ...status,
        tools: this.#entriesFor(connection).map((entry) => ({
          name: entry.definition.name,
          ...(entry.title !== undefined ? { title: entry.title } : {}),
          readOnly: entry.readOnly,
        })),
      };
    });
  }

  /** Connexion d'un serveur (diagnostics, tests). */
  connection(name: string): McpConnection | undefined {
    return this.#connections.get(name);
  }

  /**
   * Catalogue de tous les outils MCP connus (serveurs connectés ou en
   * reconnexion). En cas de collision de nom après normalisation, le premier gagne.
   */
  catalog(): McpCatalogEntry[] {
    const seen = new Set<string>();
    const out: McpCatalogEntry[] = [];
    for (const connection of this.#connections.values()) {
      if (connection.state === 'stopped' || connection.state === 'failed') continue;
      for (const entry of this.#entriesFor(connection)) {
        if (seen.has(entry.definition.name)) {
          this.#options.log?.('mcp:name-collision', { name: entry.definition.name });
          continue;
        }
        seen.add(entry.definition.name);
        out.push(entry);
      }
    }
    return out;
  }

  /** Définitions de tous les outils MCP (pour l'activation paresseuse côté agent-core). */
  definitions(): AnyToolDefinition[] {
    return this.catalog().map((e) => e.definition as AnyToolDefinition);
  }

  /** Appelle un outil sur un serveur. */
  readonly callTool = async (
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> => {
    const connection = this.#connections.get(server);
    if (!connection) {
      throw new AtelierError('mcp/server_failed', `Le connecteur ${server} n'est plus configuré.`);
    }
    return connection.callTool(tool, args, signal);
  };

  /** S'abonne aux changements (état, outils) ; renvoie la fonction de désabonnement. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #entriesFor(connection: McpConnection): McpCatalogEntry[] {
    const tools = connection.tools;
    const cached = this.#catalogCache.get(connection.name);
    if (cached?.tools === tools) return cached.entries;
    const entries = tools.map((tool) => toCatalogEntry(connection.name, tool, this.callTool));
    this.#catalogCache.set(connection.name, { tools, entries });
    return entries;
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Écouteur défaillant ignoré.
      }
    }
  }
}
