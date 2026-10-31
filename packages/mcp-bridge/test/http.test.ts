/**
 * Transport streamable HTTP (serveur MCP réel sur un port local) et cas de
 * cycle de vie avec un transport en mémoire (liste d'outils modifiée,
 * reconnexion à la demande, rechargement de la configuration).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  McpManager,
  parseMcpConfig,
  type McpServerConfig,
  type TransportFactory,
} from '../src/index.js';
import { makeContext, waitFor } from './helpers.js';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'meteo', version: '1.2.3' });
  server.registerTool(
    'forecast',
    {
      title: 'Prévisions',
      description: 'Prévisions météo pour une ville.',
      inputSchema: { city: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ city }) => ({ content: [{ type: 'text', text: `${city} : ensoleillé, 21 °C` }] }),
  );
  return server;
}

describe('streamable HTTP', { timeout: 20_000 }, () => {
  let http: Server;
  let url = '';
  const seenAuth: (string | undefined)[] = [];

  beforeAll(async () => {
    http = createServer((req: IncomingMessage, res) => {
      seenAuth.push(req.headers.authorization);
      // Mode sans état : un serveur et un transport par requête.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      void server.connect(transport).then(() => transport.handleRequest(req, res));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await new Promise((resolve) => http.close(resolve));
  });

  it('se connecte, transmet les en-têtes et appelle un outil', async () => {
    const manager = new McpManager();
    await manager.apply(
      parseMcpConfig({
        mcpServers: { meteo: { type: 'http', url, headers: { Authorization: 'Bearer secret' } } },
      }),
    );
    try {
      expect(manager.status()[0]).toMatchObject({
        state: 'connected',
        transport: 'http',
        serverInfo: { name: 'meteo', version: '1.2.3' },
      });
      const forecast = manager.catalog()[0];
      expect(forecast?.definition.name).toBe('mcp__meteo__forecast');
      expect(forecast?.definition.permission).toBe('never');
      const { context } = makeContext();
      expect(await forecast?.definition.execute({ city: 'Liège' }, context)).toEqual({
        ok: true,
        content: 'Liège : ensoleillé, 21 °C',
      });
      expect(seenAuth.every((h) => h === 'Bearer secret')).toBe(true);
    } finally {
      await manager.stop();
    }
  });
});

describe('cycle de vie (transport en mémoire)', { timeout: 20_000 }, () => {
  /** Fabrique qui démarre un McpServer en mémoire à chaque connexion. */
  function memoryFactory(): {
    factory: TransportFactory;
    servers: McpServer[];
    serverTransports: InMemoryTransport[];
    fail: { next: boolean };
  } {
    const servers: McpServer[] = [];
    const serverTransports: InMemoryTransport[] = [];
    const fail = { next: false };
    const factory: TransportFactory = () => {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      if (fail.next) {
        client.start = () => Promise.reject(new Error('serveur indisponible'));
        return client;
      }
      const server = buildServer();
      servers.push(server);
      serverTransports.push(serverSide);
      void server.connect(serverSide);
      return client;
    };
    return { factory, servers, serverTransports, fail };
  }

  const config = (names: string[]): ReturnType<typeof parseMcpConfig> =>
    parseMcpConfig({
      mcpServers: Object.fromEntries(names.map((n) => [n, { command: `serveur-${n}` }])),
    });

  it('suit notifications/tools/list_changed', async () => {
    const memory = memoryFactory();
    const manager = new McpManager({ createTransport: memory.factory });
    let changes = 0;
    manager.onChange(() => changes++);
    await manager.apply(config(['meteo']));
    expect(manager.catalog().map((e) => e.toolName)).toEqual(['forecast']);

    memory.servers[0]?.registerTool('alerts', { description: 'Alertes météo' }, () => ({
      content: [{ type: 'text', text: 'aucune' }],
    }));
    await waitFor(() => manager.catalog().length === 2);
    expect(manager.catalog().map((e) => e.definition.name)).toContain('mcp__meteo__alerts');
    expect(changes).toBeGreaterThan(0);
    await manager.stop();
  });

  it('status() liste les outils des serveurs connectés, mis à jour par list_changed', async () => {
    const memory = memoryFactory();
    const manager = new McpManager({ createTransport: memory.factory });
    await manager.apply(config(['meteo']));
    expect(manager.status()[0]?.tools).toEqual([
      { name: 'mcp__meteo__forecast', title: 'Prévisions', readOnly: true },
    ]);

    // Outil en écriture (sans readOnlyHint), annoncé par tools/list_changed.
    memory.servers[0]?.registerTool(
      'send_alert',
      { description: 'Envoie une alerte', annotations: { title: 'Alerter' } },
      () => ({ content: [{ type: 'text', text: 'envoyée' }] }),
    );
    await waitFor(() => manager.status()[0]?.tools?.length === 2);
    expect(manager.status()[0]?.tools).toEqual([
      { name: 'mcp__meteo__forecast', title: 'Prévisions', readOnly: true },
      { name: 'mcp__meteo__send_alert', title: 'Alerter', readOnly: false },
    ]);
    // Le nom est la scopeKey des demandes de permission.
    const write = manager.catalog().find((e) => e.toolName === 'send_alert');
    expect(write?.definition.describePermission?.({}).scopeKey).toBe('mcp__meteo__send_alert');
    await manager.stop();
  });

  it('status() : pas de `tools` tant que le serveur n’est pas connecté', async () => {
    const memory = memoryFactory();
    const manager = new McpManager({
      createTransport: memory.factory,
      reconnect: { baseDelayMs: 10, maxAttempts: 1 },
    });
    await manager.apply(config(['meteo']));
    expect(manager.status()[0]?.tools).toHaveLength(1);

    // Connexion perdue : le catalogue garde les outils (reconnexion), pas le statut.
    memory.fail.next = true;
    await memory.serverTransports[0]?.close();
    await waitFor(() => manager.status()[0]?.state === 'failed');
    const status = manager.status()[0];
    expect(status && 'tools' in status).toBe(false);
    await manager.stop();
  });

  it('passe en échec après les tentatives, puis se reconnecte à la demande', async () => {
    const memory = memoryFactory();
    const manager = new McpManager({
      createTransport: memory.factory,
      reconnect: { baseDelayMs: 10, maxAttempts: 2 },
    });
    await manager.apply(config(['meteo']));
    const connection = manager.connection('meteo');
    const tool = manager.catalog()[0]?.definition;

    memory.fail.next = true;
    await memory.serverTransports[0]?.close();
    await waitFor(() => connection?.state === 'failed');
    expect(connection?.status().reconnectAttempts).toBe(3);
    // Plus de serveur : l'outil répond une erreur lisible, sans lever.
    const { context } = makeContext();
    const down = await tool?.execute({ city: 'Namur' }, context);
    expect(down?.ok).toBe(false);
    expect(down?.content).toMatch(/indisponible/);

    // Le serveur revient : l'appel suivant reconnecte immédiatement.
    memory.fail.next = false;
    const up = await tool?.execute({ city: 'Namur' }, context);
    expect(up).toEqual({ ok: true, content: 'Namur : ensoleillé, 21 °C' });
    expect(connection?.state).toBe('connected');
    await manager.stop();
  });

  it('apply() ne redémarre que les serveurs ajoutés ou modifiés', async () => {
    const memory = memoryFactory();
    const manager = new McpManager({ createTransport: memory.factory });
    await manager.apply(config(['a', 'b']));
    const a = manager.connection('a');
    const b = manager.connection('b');

    const changed = config(['a', 'c']);
    (changed.servers[0] as McpServerConfig & { args: string[] }).args = ['--v2'];
    await manager.apply(changed);
    expect(manager.connection('a')).not.toBe(a);
    expect(b?.state).toBe('stopped');
    expect(
      manager
        .status()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['a', 'c']);

    const unchanged = manager.connection('c');
    await manager.apply(changed);
    expect(manager.connection('c')).toBe(unchanged);

    // Un outil d'un serveur retiré renvoie une erreur claire.
    const { context } = makeContext();
    await expect(manager.callTool('b', 'forecast', {}, context.abortSignal)).rejects.toThrow(
      /n'est plus configuré/,
    );
    await manager.stop();
  });
});
