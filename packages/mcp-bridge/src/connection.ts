/**
 * Connexion à UN serveur MCP (stdio ou streamable HTTP), lancée côté hôte.
 *
 * Cycle de vie : `connecting` → `connected` ; sur fermeture inattendue (processus
 * mort, transport coupé) ou échec de connexion : `reconnecting` avec délai
 * exponentiel, puis `failed` après `maxAttempts`. Un appel d'outil sur un serveur
 * déconnecté tente une reconnexion immédiate. `stop()` ferme le client, ce qui
 * termine le processus enfant (stdio).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AtelierError } from '@atelier/shared';
import type { McpServerConfig } from './config.js';
import type { McpCallResult, McpToolInfo } from './tools.js';

/** État d'un serveur MCP. */
export type McpServerState = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped';

/** Instantané d'un serveur (Réglages, diagnostics). */
export interface McpServerStatus {
  name: string;
  transport: McpServerConfig['transport'];
  state: McpServerState;
  /** Nombre d'outils publiés. */
  toolCount: number;
  /** Nom et version annoncés par le serveur. */
  serverInfo?: { name: string; version: string };
  /** Dernière erreur lisible (avec la fin de stderr pour un serveur stdio). */
  error?: string;
  /** Tentatives de reconnexion consécutives. */
  reconnectAttempts: number;
}

/** Fabrique de transport injectable (tests). */
export type TransportFactory = (config: McpServerConfig, env: NodeJS.ProcessEnv) => Transport;

/** Politique de reconnexion. */
export interface ReconnectPolicy {
  /** Tentatives avant l'état `failed` (défaut 5). */
  maxAttempts: number;
  /** Premier délai en ms (défaut 1 000), doublé à chaque tentative. */
  baseDelayMs: number;
  /** Délai maximal en ms (défaut 30 000). */
  maxDelayMs: number;
}

/** Options d'une connexion. */
export interface McpConnectionOptions {
  /** Fabrique de transport (défaut : stdio / streamable HTTP du SDK). */
  createTransport?: TransportFactory;
  /** Environnement de base des serveurs stdio (défaut : `process.env`). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Dossiers ajoutés au PATH (une app lancée depuis le Finder n'a pas Homebrew). */
  extraPath?: readonly string[];
  /** Délai de connexion (initialize + tools/list), défaut 60 s (`npx` peut télécharger). */
  connectTimeoutMs?: number;
  /** Délai d'un appel d'outil, défaut 120 s. */
  callTimeoutMs?: number;
  /** Politique de reconnexion. */
  reconnect?: Partial<ReconnectPolicy>;
  /** Appelé à chaque changement d'état ou de liste d'outils. */
  onChange?: () => void;
  /** Journal de diagnostic. */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Dossiers ajoutés au PATH par défaut (Homebrew Apple Silicon et Intel). */
export const DEFAULT_EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'] as const;
const CLIENT_INFO = { name: 'atelier', version: '0.1.0' };
const STDERR_TAIL_BYTES = 2_000;
const CLOSE_TIMEOUT_MS = 5_000;

/** Environnement d'un serveur stdio : variables sûres + PATH complété + `env` de la config. */
export function buildServerEnv(
  base: NodeJS.ProcessEnv,
  extraPath: readonly string[],
  configEnv: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  // `getDefaultEnvironment` lit process.env : on prend PATH/HOME… de `base` si fourni.
  for (const key of ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'LANG', 'TMPDIR']) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  const path = (env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of extraPath) if (!path.includes(dir)) path.push(dir);
  env.PATH = path.join(':');
  return { ...env, ...configEnv };
}

/** Transport par défaut du SDK. */
export const defaultTransportFactory: TransportFactory = (config, env) => {
  if (config.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: env as Record<string, string>,
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    stderr: 'pipe',
  });
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Connexion à un serveur MCP. */
export class McpConnection {
  readonly config: McpServerConfig;
  readonly #options: McpConnectionOptions;
  readonly #policy: ReconnectPolicy;
  #client: Client | undefined;
  #transport: Transport | undefined;
  #state: McpServerState = 'connecting';
  #tools: McpToolInfo[] = [];
  #error: string | undefined;
  #stderrTail = '';
  #attempts = 0;
  #timer: NodeJS.Timeout | undefined;
  #connecting: Promise<void> | undefined;

  constructor(config: McpServerConfig, options: McpConnectionOptions = {}) {
    this.config = config;
    this.#options = options;
    this.#policy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000, ...options.reconnect };
  }

  get name(): string {
    return this.config.name;
  }

  get state(): McpServerState {
    return this.#state;
  }

  /** Derniers outils connus (conservés pendant une reconnexion). */
  get tools(): readonly McpToolInfo[] {
    return this.#tools;
  }

  /** PID du processus enfant (stdio), s'il tourne. */
  get pid(): number | undefined {
    const transport = this.#transport;
    return transport instanceof StdioClientTransport ? (transport.pid ?? undefined) : undefined;
  }

  status(): McpServerStatus {
    const info = this.#client?.getServerVersion();
    return {
      name: this.name,
      transport: this.config.transport,
      state: this.#state,
      toolCount: this.#tools.length,
      ...(info ? { serverInfo: { name: info.name, version: info.version } } : {}),
      ...(this.#error !== undefined ? { error: this.#error } : {}),
      reconnectAttempts: this.#attempts,
    };
  }

  /**
   * Première connexion. Ne lève jamais : en cas d'échec, la connexion passe en
   * `reconnecting` (ou `failed`) et l'erreur est visible dans {@link status}.
   */
  async start(): Promise<void> {
    try {
      await this.#connectOnce();
    } catch {
      this.#scheduleReconnect();
    }
  }

  /** Appelle un outil, avec une reconnexion immédiate si le serveur est tombé. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    if (this.#state === 'stopped') {
      throw new AtelierError('mcp/server_failed', `Le connecteur ${this.name} est arrêté.`);
    }
    if (this.#state !== 'connected') {
      try {
        this.#clearTimer();
        await this.#connectOnce();
      } catch (error) {
        this.#scheduleReconnect();
        throw new AtelierError(
          'mcp/server_failed',
          `Le connecteur ${this.name} est indisponible : ${errorText(error)}`,
          { retryable: true, cause: error },
        );
      }
    }
    const client = this.#client;
    if (!client)
      throw new AtelierError('mcp/server_failed', `Le connecteur ${this.name} est indisponible.`);
    return await client.callTool({ name, arguments: args }, undefined, {
      ...(signal ? { signal } : {}),
      timeout: this.#options.callTimeoutMs ?? 120_000,
      resetTimeoutOnProgress: true,
    });
  }

  /** Ferme le client et termine le processus du serveur. */
  async stop(): Promise<void> {
    this.#state = 'stopped';
    this.#clearTimer();
    const client = this.#client;
    this.#client = undefined;
    this.#transport = undefined;
    if (client) await this.#closeQuietly(client);
    this.#notify();
  }

  // --- interne

  #notify(): void {
    try {
      this.#options.onChange?.();
    } catch {
      // Un écouteur défaillant ne doit pas casser la connexion.
    }
  }

  #setState(state: McpServerState, error?: string): void {
    if (this.#state === 'stopped') return;
    this.#state = state;
    this.#error = error;
    this.#notify();
  }

  #isStopped(): boolean {
    return this.#state === 'stopped';
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #closeQuietly(client: Client): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.close(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Déjà fermé.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Une tentative de connexion ; les appels concurrents partagent la même. */
  #connectOnce(): Promise<void> {
    this.#connecting ??= this.#doConnect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #doConnect(): Promise<void> {
    if (this.#state === 'stopped')
      throw new AtelierError('mcp/server_failed', 'Connecteur arrêté.');
    const previous = this.#client;
    this.#client = undefined;
    if (previous) await this.#closeQuietly(previous);
    if (this.#state !== 'reconnecting') this.#setState('connecting');

    const env = buildServerEnv(
      this.#options.baseEnv ?? process.env,
      this.#options.extraPath ?? DEFAULT_EXTRA_PATH,
      this.config.transport === 'stdio' ? this.config.env : {},
    );
    const transport = (this.#options.createTransport ?? defaultTransportFactory)(this.config, env);
    this.#stderrTail = '';
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on('data', (chunk: Buffer) => {
        this.#stderrTail = (this.#stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
    }
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    client.onclose = () => {
      this.#handleClose(client);
    };
    client.onerror = (error) => {
      this.#options.log?.('mcp:transport-error', { server: this.name, error: errorText(error) });
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (this.#client !== client) return;
      try {
        await this.#refreshTools(client);
        this.#notify();
      } catch (error) {
        this.#options.log?.('mcp:list-changed-failed', {
          server: this.name,
          error: errorText(error),
        });
      }
    });

    const timeout = this.#options.connectTimeoutMs ?? 60_000;
    try {
      await client.connect(transport, { timeout });
      // `stop()` a pu être appelé pendant la connexion.
      if (this.#isStopped()) {
        await this.#closeQuietly(client);
        throw new AtelierError('mcp/server_failed', 'Connecteur arrêté.');
      }
      this.#client = client;
      this.#transport = transport;
      await this.#refreshTools(client, timeout);
    } catch (error) {
      if (this.#client === client) this.#client = undefined;
      await this.#closeQuietly(client);
      const stderr = this.#stderrTail.trim();
      const message = `${errorText(error)}${stderr ? `\n${stderr}` : ''}`;
      if (!this.#isStopped()) this.#error = message;
      throw new AtelierError(
        'mcp/server_failed',
        `Connexion à ${this.name} impossible : ${message}`,
        {
          retryable: true,
          cause: error,
        },
      );
    }
    this.#attempts = 0;
    this.#setState('connected');
    this.#options.log?.('mcp:connected', { server: this.name, tools: this.#tools.length });
  }

  async #refreshTools(client: Client, timeout?: number): Promise<void> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    // Pagination ; borne de sécurité contre un serveur qui boucle.
    for (let page = 0; page < 50; page++) {
      const result = await client.listTools(
        cursor ? { cursor } : undefined,
        timeout ? { timeout } : undefined,
      );
      tools.push(...(result.tools as McpToolInfo[]));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    this.#tools = tools;
  }

  #handleClose(client: Client): void {
    // Fermeture voulue (stop, remplacement) ou client périmé : rien à faire.
    if (this.#client !== client || this.#state === 'stopped') return;
    this.#client = undefined;
    this.#transport = undefined;
    const stderr = this.#stderrTail.trim();
    this.#options.log?.('mcp:closed', { server: this.name });
    this.#error = `Connexion perdue${stderr ? ` :\n${stderr}` : ''}`;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#state === 'stopped' || this.#timer) return;
    this.#attempts++;
    if (this.#attempts > this.#policy.maxAttempts) {
      this.#setState('failed', this.#error);
      return;
    }
    const delay = Math.min(
      this.#policy.baseDelayMs * 2 ** (this.#attempts - 1),
      this.#policy.maxDelayMs,
    );
    this.#setState('reconnecting', this.#error);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#connectOnce().catch(() => {
        this.#scheduleReconnect();
      });
    }, delay);
    this.#timer.unref();
  }
}
