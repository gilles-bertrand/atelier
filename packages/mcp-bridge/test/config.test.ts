import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultMcpConfigPath,
  loadMcpConfig,
  parseMcpConfig,
  parseMcpConfigText,
} from '../src/index.js';
import { tempDir } from './helpers.js';

const HOME = '/Users/alice';

describe('parseMcpConfig', () => {
  it('lit le format Claude Desktop (stdio)', () => {
    const config = parseMcpConfig(
      {
        mcpServers: {
          fichiers: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/alice/Documents'],
            env: { DEBUG: '1' },
          },
          outil: { command: '~/bin/outil', cwd: '~/projets' },
        },
      },
      HOME,
    );
    expect(config.issues).toEqual([]);
    expect(config.servers).toEqual([
      {
        name: 'fichiers',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/alice/Documents'],
        env: { DEBUG: '1' },
      },
      {
        name: 'outil',
        transport: 'stdio',
        command: '/Users/alice/bin/outil',
        args: [],
        env: {},
        cwd: '/Users/alice/projets',
      },
    ]);
  });

  it('lit les serveurs streamable HTTP', () => {
    const config = parseMcpConfig({
      mcpServers: {
        notion: {
          type: 'http',
          url: 'https://mcp.notion.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
        local: { url: 'http://localhost:3000/mcp' },
      },
    });
    expect(config.servers).toEqual([
      {
        name: 'notion',
        transport: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
      { name: 'local', transport: 'http', url: 'http://localhost:3000/mcp', headers: {} },
    ]);
  });

  it('isole les serveurs invalides sans bloquer les autres', () => {
    const config = parseMcpConfig({
      mcpServers: {
        ok: { command: 'node' },
        vide: { command: '' },
        sse: { type: 'sse', url: 'https://exemple.fr/sse' },
        clair: { url: 'http://exemple.fr/mcp' },
        cassé: 42,
        'nom/interdit': { command: 'node' },
        off: { command: 'node', disabled: true },
      },
    });
    expect(config.servers.map((s) => s.name)).toEqual(['ok']);
    expect(config.disabled).toEqual(['off']);
    const byServer = Object.fromEntries(config.issues.map((i) => [i.server, i.message]));
    expect(byServer.vide).toMatch(/commande vide/);
    expect(byServer.sse).toMatch(/SSE non pris en charge/);
    expect(byServer.clair).toMatch(/https obligatoire/);
    expect(byServer['cassé']).toMatch(/objet/);
    expect(byServer['nom/interdit']).toMatch(/nom de serveur invalide/);
  });

  it('refuse une structure racine invalide', () => {
    expect(() => parseMcpConfig({ mcpServers: [] })).toThrow(/mcp\.json invalide/);
  });
});

describe('parseMcpConfigText / loadMcpConfig', () => {
  it('JSON illisible → mcp/config_invalid', () => {
    expect(() => parseMcpConfigText('{ "mcpServers": ')).toThrow(
      expect.objectContaining({ code: 'mcp/config_invalid' }) as Error,
    );
  });

  it('texte vide ou fichier absent → configuration vide', async () => {
    expect(parseMcpConfigText('  ').servers).toEqual([]);
    const dir = tempDir();
    expect(await loadMcpConfig(join(dir, 'absent.json'))).toEqual({
      servers: [],
      disabled: [],
      issues: [],
    });
  });

  it('lit un fichier sur disque', async () => {
    const dir = tempDir();
    const path = join(dir, 'mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { a: { command: 'node', args: ['x.js'] } } }));
    expect((await loadMcpConfig(path)).servers).toHaveLength(1);
  });

  it('chemin par défaut : ~/Atelier/mcp.json', () => {
    expect(defaultMcpConfigPath('/Users/alice')).toBe('/Users/alice/Atelier/mcp.json');
  });
});
