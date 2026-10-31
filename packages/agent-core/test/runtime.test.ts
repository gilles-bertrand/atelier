/** `createAgentRuntime` : fabrique utilisée par le process main. */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, type AnyToolDefinition, type Sandbox } from '@atelier/shared';
import { createAgentRuntime } from '../src/index.js';
import { collect, permissions, promptText, scriptedModel, withTempDir } from './helpers.js';

type FetchArgs = Parameters<typeof fetch>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const showOk = (): ReturnType<typeof vi.fn<(...a: FetchArgs) => Promise<Response>>> =>
  vi
    .fn<(...a: FetchArgs) => Promise<Response>>()
    .mockImplementation(() => Promise.resolve(json({ parameters: 'num_ctx 65536' })));

function echoTool(name: string, source: 'web' | 'mcp' = 'web'): AnyToolDefinition {
  return defineTool({
    name,
    description: `Outil ${name}`,
    inputSchema: z.object({}),
    permission: 'never',
    source,
    execute: () => Promise.resolve({ ok: true, content: `${name} ok` }),
  });
}

const llm = { baseUrl: 'https://llm.example.com', model: 'atelier', token: 'tok' };

describe('createAgentRuntime', () => {
  it('lit la fenêtre de contexte et l’applique aux sessions', async () => {
    const fetch = showOk();
    const runtime = await createAgentRuntime({
      llm: { ...llm, fetch },
      models: { model: scriptedModel([]), fastModel: scriptedModel([]) },
    });
    expect(runtime.contextWindow).toBe(65536);
    expect(runtime.contextWindowSource).toBe('num_ctx');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://llm.example.com/api/show');
  });

  it('serveur injoignable : pas d’exception, repli puis refresh', async () => {
    const fetch = vi
      .fn<(...a: FetchArgs) => Promise<Response>>()
      .mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      )
      .mockResolvedValue(json({ parameters: 'num_ctx 40960' }));
    const log = vi.fn();
    const runtime = await createAgentRuntime({
      llm: { ...llm, fetch },
      models: { model: scriptedModel([]), fastModel: scriptedModel([]) },
      log,
    });
    expect(runtime.contextWindowSource).toBe('fallback');
    expect(runtime.contextWindow).toBe(32_768);
    expect(log).toHaveBeenCalledWith(
      'context-window:fallback',
      expect.objectContaining({ code: 'llm/unreachable' }),
    );
    expect(await runtime.refreshContextWindow()).toBe(40960);
    expect(runtime.contextWindowSource).toBe('num_ctx');
  });

  it('URL non https refusée dès la construction', async () => {
    await expect(
      createAgentRuntime({ llm: { baseUrl: 'http://example.com', model: 'm' } }),
    ).rejects.toMatchObject({ code: 'llm/insecure_url' });
  });

  it('registre par session : outils fournis + outils de session, isolés', async () => {
    await withTempDir(async (ws) => {
      const sessionTools = vi.fn((registry: { list(): unknown[] }) => {
        expect(registry.list().length).toBeGreaterThan(0);
        return [echoTool('tool_search', 'mcp')];
      });
      const runtime = await createAgentRuntime({
        llm: { ...llm, numCtx: 8192 },
        models: { model: scriptedModel([]), fastModel: scriptedModel([]) },
        tools: [echoTool('web_search')],
        sessionTools,
      });
      expect(runtime.contextWindowSource).toBe('override');
      const a = runtime.createSession({
        sessionId: 'a',
        workspace: ws,
        requestPermission: permissions(),
      });
      const b = runtime.createSession({
        sessionId: 'b',
        workspace: ws,
        requestPermission: permissions(),
      });
      expect(sessionTools).toHaveBeenCalledTimes(2);
      const names = a.agent.options.registry.list().map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(['read_file', 'bash', 'web_search', 'tool_search']),
      );
      expect(a.agent.options.registry).not.toBe(b.agent.options.registry);
      expect(a.agent.options.contextWindow).toBe(8192);
      expect(a.agent.options.workspace).toBe(ws);
    });
  });

  it('getters relus à chaque tour : VM prête après la création, skills, consignes, turnId', async () => {
    await withTempDir(async (ws) => {
      const vm: { current?: Sandbox } = {};
      let extra = 'Consigne A';
      const model = scriptedModel([{ text: 'un' }, { text: 'deux' }]);
      const runtime = await createAgentRuntime({
        llm: { ...llm, numCtx: 8192 },
        models: { model, fastModel: model },
        sandbox: () => vm.current,
        skills: () => [{ name: 'xlsx', description: 'Classeurs Excel', path: '/s/xlsx/SKILL.md' }],
        extraInstructions: () => extra,
      });
      const session = runtime.createSession({
        sessionId: 's',
        workspace: ws,
        requestPermission: permissions(),
      });
      expect(session.agent.currentSandbox()).toBeUndefined();

      const first = collect();
      await session.send('Bonjour', first.emit, undefined, { turnId: 'turn-x' });
      expect(first.events.every((e) => e.turnId === 'turn-x')).toBe(true);
      expect(promptText(model, 0)).toContain('Consigne A');
      expect(promptText(model, 0)).toContain('xlsx');

      vm.current = { exec: vi.fn() } as unknown as Sandbox;
      extra = 'Consigne B';
      await session.send('Encore', collect().emit);
      expect(session.agent.currentSandbox()).toBe(vm.current);
      expect(promptText(model, 1)).toContain('Consigne B');
      expect(promptText(model, 1)).not.toBe(promptText(model, 0));
    });
  });

  it('session sans VM (`sandbox: false`) : bash n’exécute rien, l’autre session garde la VM', async () => {
    await withTempDir(async (ws) => {
      const exec = vi.fn(() =>
        Promise.resolve({
          exitCode: 0,
          stdout: 'rapport.md\n',
          stderr: '',
          truncated: false,
          timedOut: false,
          durationMs: 5,
        }),
      );
      const vm = { exec } as unknown as Sandbox;
      const bashLs = { toolCalls: [{ name: 'bash', input: { command: 'ls' } }] };
      const model = scriptedModel([bashLs, { text: 'sans VM' }, bashLs, { text: 'avec VM' }]);
      const runtime = await createAgentRuntime({
        llm: { ...llm, numCtx: 8192 },
        models: { model, fastModel: model },
        sandbox: () => vm,
      });
      const base = { workspace: ws, requestPermission: permissions() };

      const run = runtime.createSession({ ...base, sessionId: 'run', sandbox: false });
      expect(run.agent.currentSandbox()).toBeUndefined();
      const runEvents = collect();
      await run.send('Liste le dossier.', runEvents.emit);
      expect(exec).not.toHaveBeenCalled();
      const refused = runEvents.events.find((e) => e.type === 'tool_result');
      expect(refused).toMatchObject({ toolName: 'bash', ok: false });
      expect(JSON.stringify(refused)).toContain("n'est pas disponible");

      const chat = runtime.createSession({ ...base, sessionId: 'chat' });
      expect(chat.agent.currentSandbox()).toBe(vm);
      await chat.send('Liste le dossier.', collect().emit);
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });

  it('permissions « pour la session » mémorisées par session', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([
        { toolCalls: [{ name: 'write_file', input: { path: 'a.txt', content: 'a' } }] },
        { toolCalls: [{ name: 'write_file', input: { path: 'a.txt', content: 'b' } }] },
        { text: 'fini' },
      ]);
      const perms = permissions('allow_session');
      const runtime = await createAgentRuntime({
        llm: { ...llm, numCtx: 8192 },
        models: { model, fastModel: model },
      });
      const session = runtime.createSession({
        sessionId: 's',
        workspace: ws,
        requestPermission: perms,
      });
      const result = await session.send('Écris', collect().emit);
      expect(result.reason).toBe('stop');
      expect(perms.requests).toHaveLength(1);
    });
  });

  it('session recréée : historique et lastInputTokens transmis', async () => {
    await withTempDir(async (ws) => {
      const model = scriptedModel([{ text: 'un', inputTokens: 7000 }]);
      const runtime = await createAgentRuntime({
        llm: { ...llm, numCtx: 8192 },
        models: { model, fastModel: model },
      });
      const old = runtime.createSession({
        sessionId: 's',
        workspace: ws,
        requestPermission: permissions(),
      });
      expect(old.lastInputTokens).toBeUndefined();
      await old.send('Bonjour', collect().emit);
      expect(old.lastInputTokens).toBe(7000);
      expect(old.history.length).toBeGreaterThan(1);

      const next = runtime.createSession({
        sessionId: 's',
        workspace: ws,
        requestPermission: permissions(),
        history: old.history,
        ...(old.lastInputTokens !== undefined ? { lastInputTokens: old.lastInputTokens } : {}),
      });
      expect(next.history).toEqual(old.history);
      expect(next.lastInputTokens).toBe(7000);
    });
  });
});
