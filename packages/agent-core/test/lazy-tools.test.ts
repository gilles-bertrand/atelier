/**
 * `AgentOptions.lazyTools` : outils déclarés en début de tour mais inactifs tant
 * qu'ils ne sont pas dans le registre ; un outil activé pendant le tour (via
 * `tool_search`) est appelable dès l'étape suivante.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type AnyToolDefinition, type ToolRegistry } from '@atelier/shared';
import { Agent, createDefaultRegistry } from '../src/index.js';
import { collect, permissions, scriptedModel, withTempDir } from './helpers.js';

const NOW = new Date('2026-10-28T10:00:00Z');

function mcpTool(name: string, permission: 'never' | 'always', execute = vi.fn()) {
  execute.mockResolvedValue({ ok: true, content: `${name} exécuté` });
  const definition = defineTool({
    name,
    description: `Outil MCP ${name}`,
    inputSchema: z.object({ city: z.string() }),
    permission,
    source: 'mcp',
    execute,
  }) as AnyToolDefinition;
  return { definition, execute };
}

/** `tool_search` minimal : active tous les outils paresseux dont le nom contient la requête. */
function fakeToolSearch(registry: ToolRegistry, lazy: readonly AnyToolDefinition[]) {
  return defineTool({
    name: 'tool_search',
    description: 'Active des outils MCP.',
    inputSchema: z.object({ query: z.string() }),
    permission: 'never',
    source: 'mcp',
    execute: ({ query }) => {
      const found = lazy.filter((t) => t.name.includes(query) && !registry.has(t.name));
      for (const t of found) registry.register(t);
      return Promise.resolve({
        ok: true,
        content: `Activés : ${found.map((t) => t.name).join(', ')}`,
      });
    },
  }) as AnyToolDefinition;
}

const toolNames = (call: { tools?: { name: string }[] } | undefined): string[] =>
  (call?.tools ?? []).map((t) => t.name);

function setup(ws: string, steps: Parameters<typeof scriptedModel>[0], lazy: AnyToolDefinition[]) {
  const registry = createDefaultRegistry();
  registry.register(fakeToolSearch(registry, lazy));
  const model = scriptedModel(steps);
  const perms = permissions();
  const agent = new Agent({
    model,
    registry,
    workspace: ws,
    requestPermission: perms,
    contextWindow: 32_768,
    now: () => NOW,
    lazyTools: () => lazy,
  });
  return { agent, model, registry, perms };
}

async function run(agent: Agent) {
  const { events, emit } = collect();
  const result = await agent.runTurn({
    sessionId: 's1',
    turnId: 't1',
    history: [],
    input: 'Météo ?',
    emit,
  });
  return { result, events };
}

describe('lazyTools', () => {
  it('tool_search à l’étape 1 → outil appelable à l’étape 2 du même tour', async () => {
    await withTempDir(async (ws) => {
      const forecast = mcpTool('mcp__meteo__forecast', 'never');
      const { agent, model, registry } = setup(
        ws,
        [
          { toolCalls: [{ name: 'tool_search', input: { query: 'forecast' } }] },
          { toolCalls: [{ name: 'mcp__meteo__forecast', input: { city: 'Liège' } }] },
          { text: 'Il fait beau à Liège.' },
        ],
        [forecast.definition],
      );
      const { result, events } = await run(agent);

      expect(result.reason).toBe('stop');
      // Étape 1 : l'outil paresseux n'est pas proposé au modèle.
      expect(toolNames(model.doStreamCalls[0])).toContain('tool_search');
      expect(toolNames(model.doStreamCalls[0])).not.toContain('mcp__meteo__forecast');
      // Étape 2 : activé par tool_search, il est proposé… et exécuté.
      expect(toolNames(model.doStreamCalls[1])).toContain('mcp__meteo__forecast');
      expect(forecast.execute).toHaveBeenCalledOnce();
      expect(registry.has('mcp__meteo__forecast')).toBe(true);
      const outputs = events.flatMap((e) => (e.type === 'tool_result' ? [[e.toolName, e.ok]] : []));
      expect(outputs).toEqual([
        ['tool_search', true],
        ['mcp__meteo__forecast', true],
      ]);
    });
  });

  it('un outil paresseux non activé est refusé sans exécution ni permission', async () => {
    await withTempDir(async (ws) => {
      const create = mcpTool('mcp__gh__create_issue', 'always');
      const { agent, perms } = setup(
        ws,
        [
          { toolCalls: [{ name: 'mcp__gh__create_issue', input: { city: 'x' } }] },
          { text: 'Je dois d’abord activer l’outil.' },
        ],
        [create.definition],
      );
      const { result, events } = await run(agent);
      expect(result.reason).toBe('stop');
      expect(create.execute).not.toHaveBeenCalled();
      expect(perms.requests).toEqual([]);
      const refusal = events.find((e) => e.type === 'tool_result');
      expect(refusal).toMatchObject({ toolName: 'mcp__gh__create_issue', ok: false });
      // Le modèle apprend quels outils sont disponibles (dont tool_search).
      expect(refusal?.type === 'tool_result' ? refusal.output : '').toMatch(
        /unavailable tool 'mcp__gh__create_issue'.*tool_search/,
      );
    });
  });

  it('la permission reste demandée pour un outil d’écriture activé', async () => {
    await withTempDir(async (ws) => {
      const create = mcpTool('mcp__gh__create_issue', 'always');
      const { agent, perms } = setup(
        ws,
        [
          { toolCalls: [{ name: 'tool_search', input: { query: 'create_issue' } }] },
          { toolCalls: [{ name: 'mcp__gh__create_issue', input: { city: 'x' } }] },
          { text: 'Issue créée.' },
        ],
        [create.definition],
      );
      await run(agent);
      expect(perms.requests.map((r) => r.toolName)).toEqual(['mcp__gh__create_issue']);
      expect(create.execute).toHaveBeenCalledOnce();
    });
  });

  it('un outil du registre prime sur un outil paresseux de même nom', async () => {
    await withTempDir(async (ws) => {
      const shadow = mcpTool('read_file', 'never');
      const { agent, model } = setup(ws, [{ text: 'ok' }], [shadow.definition]);
      await run(agent);
      expect(toolNames(model.doStreamCalls[0]).filter((n) => n === 'read_file')).toHaveLength(1);
      expect(shadow.execute).not.toHaveBeenCalled();
    });
  });
});
