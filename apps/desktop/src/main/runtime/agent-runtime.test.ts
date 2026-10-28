import { describe, expect, it } from 'vitest';
import { McpManager } from '@atelier/mcp-bridge';
import type { AppSettings } from '@atelier/shared';
import { defaultSettings } from '../settings/settings-store.js';
import { AgentRuntimeHost, searchProviders } from './agent-runtime.js';
import type { SandboxManager } from './sandbox-manager.js';

const withProvider = (provider: AppSettings['search']['provider']): AppSettings => {
  const base = defaultSettings('/h');
  return { ...base, search: { provider } };
};

describe('searchProviders', () => {
  it('suit le fournisseur des Réglages et ajoute en repli ceux qui ont une clé', () => {
    let settings = withProvider('searxng');
    const keys: Record<string, string | undefined> = { brave_search_key: 'b' };
    const providers = searchProviders(
      () => settings,
      (id) => keys[id],
    );
    expect(providers.provider().id).toBe('searxng');
    expect(providers.fallbacks().map((p) => p.id)).toEqual(['brave']);
    settings = withProvider('brave');
    expect(providers.provider().id).toBe('brave');
    expect(providers.fallbacks()).toEqual([]);
  });
});

describe('AgentRuntimeHost', () => {
  it('refuse de créer une session sans serveur configuré et change de génération à l’invalidation', async () => {
    const host = new AgentRuntimeHost({
      settings: () => defaultSettings('/h'),
      secret: () => undefined,
      sandbox: {} as SandboxManager,
      mcp: new McpManager(),
    });
    await expect(
      host.createSession({
        sessionId: 's',
        workspace: '/w',
        requestPermission: () => Promise.resolve('deny'),
        history: [],
      }),
    ).rejects.toMatchObject({ code: 'llm/unreachable' });
    const before = host.generation();
    host.invalidate();
    expect(host.generation()).toBe(before + 1);
  });
});
