/** Runs planifiés (ADR-002 D3, D4) : gestionnaire de permissions non interactif. */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionKind, PermissionRequest } from '@atelier/shared';
import {
  Agent,
  createDefaultRegistry,
  UNATTENDED_INSTRUCTIONS,
  unattendedPermissionHandler,
  type DeniedAction,
  type ScheduledPermissions,
} from '../src/index.js';
import { collect, promptText, scriptedModel, withTempDir } from './helpers.js';

const NONE: ScheduledPermissions = {
  fileWrite: false,
  commands: false,
  webDomains: [],
  mcpTools: [],
};

const ALL: ScheduledPermissions = {
  fileWrite: true,
  commands: true,
  webDomains: '*',
  mcpTools: ['mcp__github__create_issue'],
};

function request(kind: PermissionKind, scopeKey: string, toolName = scopeKey): PermissionRequest {
  return {
    id: 'r',
    sessionId: 's',
    toolCallId: 'c',
    toolName,
    kind,
    title: `Action ${scopeKey}`,
    scopeKey,
    input: {},
  };
}

const CASES: [PermissionKind, string, string, keyof ScheduledPermissions][] = [
  ['file_write', 'write_file', 'write_file', 'fileWrite'],
  ['file_write', 'edit_file', 'edit_file', 'fileWrite'],
  ['command', 'bash', 'bash', 'commands'],
  ['network', 'web_fetch:example.com', 'web_fetch', 'webDomains'],
  ['mcp_write', 'mcp__github__create_issue', 'mcp__github__create_issue', 'mcpTools'],
];

async function decide(policy: ScheduledPermissions, req: PermissionRequest) {
  const denied: DeniedAction[] = [];
  const decision = await unattendedPermissionHandler(policy, (d) => denied.push(d))(req);
  return { decision, denied };
}

describe('unattendedPermissionHandler', () => {
  it.each(CASES)(
    '%s (%s) : accordé si la case est cochée, refusé sinon',
    async (kind, scope, tool) => {
      const req = request(kind, scope, tool);
      expect(await decide(ALL, req)).toEqual({ decision: 'allow_once', denied: [] });
      expect(await decide(NONE, req)).toEqual({
        decision: 'deny',
        denied: [{ toolName: tool, kind, scopeKey: scope, title: `Action ${scope}` }],
      });
    },
  );

  it('chaque case n’accorde que son type d’action', async () => {
    for (const [, , , field] of CASES) {
      const only = { ...NONE, [field]: ALL[field] };
      for (const [kind, scope, tool, other] of CASES) {
        const { decision } = await decide(only, request(kind, scope, tool));
        expect(decision).toBe(other === field ? 'allow_once' : 'deny');
      }
    }
  });

  it('file_delete et other : toujours refusés, même avec tout coché', async () => {
    for (const kind of ['file_delete', 'other'] as const) {
      const { decision, denied } = await decide(ALL, request(kind, 'delete_file'));
      expect(decision).toBe('deny');
      expect(denied).toHaveLength(1);
    }
  });

  it('web : liste de domaines, insensible à la casse et à www.', async () => {
    const policy = { ...NONE, webDomains: ['Example.com', 'www.insee.fr'] };
    const fetchOf = (domain: string) =>
      decide(policy, request('network', `web_fetch:${domain}`, 'web_fetch'));
    expect((await fetchOf('example.com')).decision).toBe('allow_once');
    expect((await fetchOf('insee.fr')).decision).toBe('allow_once');
    expect((await fetchOf('evil.com')).decision).toBe('deny');
    // Liste nominative : un sous-domaine n'est pas couvert.
    expect((await fetchOf('docs.example.com')).decision).toBe('deny');
    expect((await fetchOf('example.com.evil.com')).decision).toBe('deny');
  });

  it('web : « * » accepte tout domaine, mais pas une autre demande réseau', async () => {
    const policy = { ...NONE, webDomains: '*' as const };
    const web = request('network', 'web_fetch:n-importe-quoi.org', 'web_fetch');
    expect((await decide(policy, web)).decision).toBe('allow_once');
    expect((await decide(policy, request('network', 'sandbox_network'))).decision).toBe('deny');
  });

  it('MCP : seuls les outils listés nommément', async () => {
    const policy = { ...NONE, mcpTools: ['mcp__github__create_issue'] };
    const mcp = (tool: string) => decide(policy, request('mcp_write', tool));
    expect((await mcp('mcp__github__create_issue')).decision).toBe('allow_once');
    expect((await mcp('mcp__github__delete_repo')).decision).toBe('deny');
  });

  it('onDenied : une fois par refus ; jamais allow_session ni mémorisation', async () => {
    const onDenied = vi.fn();
    const handler = unattendedPermissionHandler({ ...NONE, fileWrite: true }, onDenied);
    const decisions = await Promise.all([
      handler(request('command', 'bash')),
      handler(request('command', 'bash')),
      handler(request('file_write', 'write_file')),
      handler(request('file_write', 'write_file')),
      handler(request('file_delete', 'delete_file')),
    ]);
    expect(decisions).toEqual(['deny', 'deny', 'allow_once', 'allow_once', 'deny']);
    expect(onDenied).toHaveBeenCalledTimes(3);
  });

  it('dans un tour : l’écriture refusée n’a pas lieu, le modèle reçoit le refus', async () => {
    await withTempDir(async (ws) => {
      const denied: DeniedAction[] = [];
      const model = scriptedModel([
        {
          toolCalls: [{ name: 'write_file', input: { path: 'rapport.md', content: '# Rapport' } }],
        },
        { text: 'Compte rendu : écriture refusée.' },
      ]);
      const agent = new Agent({
        model,
        registry: createDefaultRegistry(),
        workspace: ws,
        requestPermission: unattendedPermissionHandler(NONE, (d) => denied.push(d)),
        contextWindow: 32_768,
        extraInstructions: UNATTENDED_INSTRUCTIONS,
      });
      const { events, emit } = collect();
      const result = await agent.runTurn({
        sessionId: 's',
        turnId: 't',
        history: [],
        input: 'Écris le rapport hebdo.',
        emit,
      });
      expect(result.reason).toBe('stop');
      expect(denied).toEqual([
        expect.objectContaining({ toolName: 'write_file', kind: 'file_write' }),
      ]);
      await expect(access(path.join(ws, 'rapport.md'))).rejects.toThrow();
      // La demande reste relayée en event (comme toute demande), puis close par le résultat.
      const types = events.map((e) => e.type);
      expect(types.indexOf('permission_request')).toBeLessThan(types.indexOf('tool_result'));
      const sent = promptText(model, 1);
      expect(sent).toContain('a refusé');
      expect(promptText(model, 0)).toContain("Tu travailles en l'absence de l'utilisateur");
    });
  });
});
