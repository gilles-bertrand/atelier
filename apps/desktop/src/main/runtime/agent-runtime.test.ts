import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@atelier/agent-core';
import { McpManager } from '@atelier/mcp-bridge';
import type { AppSettings, ModelCapability } from '@atelier/shared';
import { defaultSettings } from '../settings/settings-store.js';
import {
  AgentRuntimeHost,
  MAX_RUNTIMES,
  searchProviders,
  visionModelFor,
} from './agent-runtime.js';
import type { SandboxManager } from './sandbox-manager.js';

const withProvider = (provider: AppSettings['search']['provider']): AppSettings => {
  const base = defaultSettings('/h');
  return { ...base, search: { provider } };
};

/** Réglages avec un serveur configuré. */
const configured = (llm: Partial<AppSettings['llm']> = {}): AppSettings => {
  const base = defaultSettings('/h');
  return { ...base, llm: { ...base.llm, baseUrl: 'https://llm.exemple.fr', ...llm } };
};

type CapabilityLookup = (model: string) => Promise<readonly ModelCapability[] | undefined>;

/** Hôte dont les runtimes sont factices : on compte les créations par modèle. */
function fakeHost(settings: () => AppSettings, capabilities?: CapabilityLookup) {
  const built: string[] = [];
  const sessions: unknown[] = [];
  const refreshes: ReturnType<typeof vi.fn>[] = [];
  const host = new AgentRuntimeHost({
    settings,
    secret: () => undefined,
    sandbox: {} as SandboxManager,
    mcp: new McpManager(),
    ...(capabilities ? { capabilities } : {}),
    createRuntime: (options) => {
      built.push(options.llm.model);
      const refreshContextWindow = vi.fn(() => Promise.resolve(32_768));
      refreshes.push(refreshContextWindow);
      return Promise.resolve({
        contextWindow: 32_768,
        contextWindowSource: 'fallback',
        refreshContextWindow,
        createSession: (options: unknown) => {
          sessions.push(options);
          return { history: [] };
        },
      } as unknown as AgentRuntime);
    },
  });
  const open = (model: string) =>
    host.createSession({
      sessionId: 's',
      workspace: '/w',
      model,
      requestPermission: () => Promise.resolve('deny'),
      history: [],
    });
  return { host, built, refreshes, open, sessions };
}

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

describe('visionModelFor (D4 de #13)', () => {
  it('modèle vision des Réglages, sinon celui de la conversation s’il lit les images, sinon aucun', () => {
    const tools: ModelCapability[] = ['completion', 'tools'];
    expect(
      visionModelFor({ visionModel: 'qwen2.5vl:7b', model: 'llama3.1:8b', capabilities: tools }),
    ).toBe('qwen2.5vl:7b');
    expect(
      visionModelFor({
        visionModel: undefined,
        model: 'qwen3.5:35b',
        capabilities: [...tools, 'vision'],
      }),
    ).toBe('qwen3.5:35b');
    // Capacités inconnues (vLLM) : le modèle est supposé capable.
    expect(
      visionModelFor({ visionModel: undefined, model: 'vllm-model', capabilities: undefined }),
    ).toBe('vllm-model');
    expect(
      visionModelFor({ visionModel: undefined, model: 'llama3.1:8b', capabilities: tools }),
    ).toBeUndefined();
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
        model: 'qwen3.5:35b',
        requestPermission: () => Promise.resolve('deny'),
        history: [],
      }),
    ).rejects.toMatchObject({ code: 'llm/unreachable' });
    const before = host.generation();
    host.invalidate();
    expect(host.generation()).toBe(before + 1);
  });

  it('garde un runtime par modèle, trois au plus, et les vide quand les Réglages changent', async () => {
    const { host, built, open } = fakeHost(() => configured());
    await open('a');
    await open('a');
    await open('b');
    await open('c');
    expect(built).toEqual(['a', 'b', 'c']);
    // `a` redevient le plus récent : `d` évince `b`, le moins récemment utilisé.
    await open('a');
    await open('d');
    await open('a');
    await open('c');
    expect(built).toEqual(['a', 'b', 'c', 'd']);
    await open('b');
    expect(built).toEqual(['a', 'b', 'c', 'd', 'b']);
    host.invalidate();
    await open('a');
    expect(built).toEqual(['a', 'b', 'c', 'd', 'b', 'a']);
    expect(MAX_RUNTIMES).toBe(3);
  });

  it('« atelier » et « atelier:latest » partagent un runtime', async () => {
    const { built, open } = fakeHost(() => configured());
    await open('atelier');
    await open('atelier:latest');
    expect(built).toEqual(['atelier']);
  });

  it('ne lit les capacités du modèle que sans modèle vision dans les Réglages', async () => {
    let settings = configured();
    const capabilities = vi.fn<CapabilityLookup>(() => Promise.resolve(['completion', 'tools']));
    const { host, open } = fakeHost(() => settings, capabilities);
    await open('llama3.1:8b');
    expect(capabilities).toHaveBeenCalledWith('llama3.1:8b');
    settings = configured({ visionModel: 'qwen2.5vl:7b' });
    host.invalidate();
    await open('qwen3.5:9b');
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('une lecture des capacités en échec ne bloque pas le runtime', async () => {
    const { built, open } = fakeHost(
      () => configured(),
      () => Promise.reject(new Error('injoignable')),
    );
    await expect(open('a')).resolves.toBeDefined();
    expect(built).toEqual(['a']);
  });

  it('relit la fenêtre de contexte de chaque runtime deviné quand le serveur revient', async () => {
    const { host, refreshes, open } = fakeHost(() => configured());
    await open('a');
    await open('b');
    await host.refreshIfFallback();
    expect(refreshes.map((refresh) => refresh.mock.calls.length)).toEqual([1, 1]);
  });
});

describe('AgentRuntimeHost : runs planifiés (ADR-002)', () => {
  it('session sans VM et consignes du mode autonome transmises à agent-core', async () => {
    const { host, sessions } = fakeHost(() => configured());
    const base = {
      sessionId: 's',
      workspace: '/w',
      model: 'qwen3.5:35b',
      requestPermission: () => Promise.resolve('deny' as const),
      history: [],
    };
    await host.createSession({ ...base, sandbox: false, instructions: 'Tu travailles seul.' });
    await host.createSession(base);
    expect(sessions[0]).toMatchObject({ sandbox: false, extraInstructions: 'Tu travailles seul.' });
    expect(sessions[1]).not.toHaveProperty('sandbox');
    expect(sessions[1]).not.toHaveProperty('extraInstructions');
  });
});
