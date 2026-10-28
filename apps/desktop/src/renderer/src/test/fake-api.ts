/**
 * Fausse API preload pour les tests de composants : gestionnaires par canal,
 * journal des appels et émission d'événements du main.
 */
import { act } from '@testing-library/react';
import type {
  AppSettings,
  AtelierApi,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  IpcResult,
  SerializedAtelierError,
} from '@atelier/shared';

export type FakeHandlers = {
  [C in IpcInvokeChannel]?: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>;
};

/** Erreur à lever dans un gestionnaire factice pour simuler un `IpcResult` en échec. */
export class FakeIpcFailure extends Error {
  constructor(readonly error: SerializedAtelierError) {
    super(error.message);
  }
}

export function defaultTestSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    llm: { baseUrl: '', model: 'qwen3.5:35b', thinking: true },
    sandbox: { cpus: 4, memoryGiB: 4, networkEnabledByDefault: false },
    search: { provider: 'searxng' },
    skillsDir: '/Users/test/Atelier/skills',
    mcpConfigPath: '/Users/test/Atelier/mcp.json',
    onboardingCompleted: false,
    ...overrides,
  };
}

export interface FakeApi {
  calls: { channel: IpcInvokeChannel; request: unknown }[];
  callsTo<C extends IpcInvokeChannel>(channel: C): IpcRequest<C>[];
  emit<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void;
  handlers: FakeHandlers;
}

/** Installe `window.atelier` ; les gestionnaires peuvent être modifiés après coup. */
export function installFakeApi(handlers: FakeHandlers = {}): FakeApi {
  let settings = defaultTestSettings();
  const base: FakeHandlers = {
    'settings:get': () => settings,
    'settings:update': (patch) => {
      settings = {
        ...settings,
        ...patch,
        llm: { ...settings.llm, ...patch.llm },
        sandbox: { ...settings.sandbox, ...patch.sandbox },
        search: { ...settings.search, ...patch.search },
      };
      return settings;
    },
    'secrets:presence': () => ({
      llm_token: false,
      ollama_search_key: false,
      brave_search_key: false,
    }),
    'secrets:set': () => undefined,
    'llm:status': () => ({ health: 'unknown', checkedAt: '2026-10-28T10:00:00.000Z' }),
    'sandbox:status': () => ({ state: 'absent', networkEnabled: false }),
  };
  const all: FakeHandlers = { ...base, ...handlers };
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const calls: FakeApi['calls'] = [];

  const api = {
    invoke: async (channel: IpcInvokeChannel, request?: unknown): Promise<IpcResult<unknown>> => {
      calls.push({ channel, request });
      const handler = all[channel] as ((req: unknown) => unknown) | undefined;
      if (!handler) {
        return {
          ok: false,
          error: { code: 'internal', message: `non simulé : ${channel}`, retryable: false },
        };
      }
      try {
        return { ok: true, value: await handler(request) };
      } catch (error) {
        if (error instanceof FakeIpcFailure) return { ok: false, error: error.error };
        throw error;
      }
    },
    on: (channel: IpcEventChannel, listener: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    // Comme le preload : les chemins hôte ne viennent jamais du renderer (ici, le nom du File).
    importDroppedFiles: (sessionId: string, files: readonly File[]) =>
      api.invoke('attachment:import' as IpcInvokeChannel, {
        sessionId,
        hostPaths: files.map((file) => `/fake/${file.name}`),
      }),
    platform: { os: 'darwin', arch: 'arm64', appVersion: '0.0.0-test' },
  } as unknown as AtelierApi & {
    invoke: (channel: IpcInvokeChannel, request?: unknown) => Promise<IpcResult<unknown>>;
  };

  Object.defineProperty(window, 'atelier', { value: api, configurable: true });

  return {
    calls,
    handlers: all,
    callsTo: <C extends IpcInvokeChannel>(channel: C) =>
      calls.filter((c) => c.channel === channel).map((c) => c.request as IpcRequest<C>),
    emit: (channel, payload) => {
      act(() => {
        for (const listener of listeners.get(channel) ?? []) listener(payload);
      });
    },
  };
}
