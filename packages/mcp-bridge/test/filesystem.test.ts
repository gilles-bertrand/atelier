/**
 * Intégration contre le vrai `@modelcontextprotocol/server-filesystem`, lancé en
 * stdio par le gestionnaire (processus enfant côté hôte).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryToolRegistry } from '@atelier/shared';
import { McpManager, mcpPromptSection, parseMcpConfig, toolSearchTool } from '../src/index.js';
import { makeContext, tempDir, waitFor } from './helpers.js';

const require = createRequire(import.meta.url);
const SERVER_BIN = require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('server-filesystem (stdio)', { timeout: 30_000 }, () => {
  const root = tempDir('atelier-mcp-fs-');
  const manager = new McpManager({ reconnect: { baseDelayMs: 50, maxAttempts: 3 } });

  beforeAll(async () => {
    writeFileSync(join(root, 'notes.txt'), 'Réunion jeudi 10 h avec Dupont SA.\n');
    await manager.apply(
      parseMcpConfig({
        mcpServers: {
          fichiers: { command: process.execPath, args: [SERVER_BIN, root] },
          cassé: { command: '/chemin/inexistant/serveur-mcp' },
        },
      }),
    );
  });

  afterAll(async () => {
    await manager.stop();
  });

  it('se connecte et catalogue les outils mcp__fichiers__*', () => {
    const status = manager.status().find((s) => s.name === 'fichiers');
    expect(status).toMatchObject({
      state: 'connected',
      serverInfo: { name: 'secure-filesystem-server' },
    });
    const names = manager.catalog().map((e) => e.definition.name);
    expect(names).toContain('mcp__fichiers__read_text_file');
    expect(names).toContain('mcp__fichiers__write_file');
    expect(names.every((n) => n.startsWith('mcp__fichiers__'))).toBe(true);
  });

  it('un serveur introuvable n’empêche pas les autres et expose son erreur', () => {
    const broken = manager.status().find((s) => s.name === 'cassé');
    expect(broken?.state).toMatch(/reconnecting|failed/);
    expect(broken?.error).toMatch(/ENOENT|inexistant/);
  });

  it('respecte readOnlyHint : lecture sans permission, écriture avec', () => {
    const byName = new Map(manager.catalog().map((e) => [e.toolName, e.definition]));
    expect(byName.get('read_text_file')?.permission).toBe('never');
    expect(byName.get('list_directory')?.permission).toBe('never');
    expect(byName.get('write_file')?.permission).toBe('always');
    expect(byName.get('move_file')?.permission).toBe('always');
    expect(
      byName.get('write_file')?.describePermission?.({ path: 'a.txt', content: 'x' }),
    ).toMatchObject({
      kind: 'mcp_write',
      scopeKey: 'mcp__fichiers__write_file',
    });
  });

  it('tool_search active les outils pertinents puis ils s’exécutent', async () => {
    const registry = new InMemoryToolRegistry();
    const search = toolSearchTool({ source: manager, registry });
    const { context } = makeContext();

    const out = await search.execute({ query: 'read text file' }, context);
    expect(out.ok).toBe(true);
    expect(registry.has('mcp__fichiers__read_text_file')).toBe(true);
    // Seuls les outils trouvés sont actifs (chargement paresseux).
    expect(registry.list().length).toBeLessThan(manager.catalog().length);

    const read = registry.get('mcp__fichiers__read_text_file');
    const result = await read?.execute({ path: join(root, 'notes.txt') }, context);
    expect(result).toEqual({ ok: true, content: 'Réunion jeudi 10 h avec Dupont SA.\n' });
  });

  it('écrit un fichier (une fois la permission accordée par agent-core)', async () => {
    const write = manager.catalog().find((e) => e.toolName === 'write_file')?.definition;
    const { context } = makeContext();
    const out = await write?.execute(
      { path: join(root, 'resume.md'), content: '# Résumé\n' },
      context,
    );
    expect(out?.ok).toBe(true);
    expect(readFileSync(join(root, 'resume.md'), 'utf8')).toBe('# Résumé\n');
  });

  it('une erreur du serveur revient au modèle sans lever', async () => {
    const read = manager.catalog().find((e) => e.toolName === 'read_text_file')?.definition;
    const { context } = makeContext();
    const out = await read?.execute({ path: '/etc/passwd' }, context);
    expect(out?.ok).toBe(false);
    expect(out?.content).toMatch(/denied|outside|not allowed|Access/i);
  });

  it('se reconnecte après la mort du processus', async () => {
    const connection = manager.connection('fichiers');
    const pid = connection?.pid;
    expect(pid).toBeTypeOf('number');
    process.kill(pid as number, 'SIGKILL');
    await waitFor(() => connection?.state !== 'connected');
    await waitFor(() => connection?.state === 'connected' && connection.pid !== pid);
    expect(connection?.pid).not.toBe(pid);

    const read = manager.catalog().find((e) => e.toolName === 'read_text_file')?.definition;
    const { context } = makeContext();
    const out = await read?.execute({ path: join(root, 'notes.txt') }, context);
    expect(out?.ok).toBe(true);
  });

  it('décrit les connecteurs pour le prompt système', () => {
    expect(mcpPromptSection(manager)).toMatch(/fichiers \(\d+ outils\)/);
  });

  it('stop() termine le processus du serveur', async () => {
    const connection = manager.connection('fichiers');
    const pid = connection?.pid as number;
    expect(isAlive(pid)).toBe(true);
    await manager.stop();
    await waitFor(() => !isAlive(pid), 5_000);
    expect(manager.status()).toEqual([]);
    expect(manager.catalog()).toEqual([]);
  });
});
