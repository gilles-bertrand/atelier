/**
 * État global de l'app côté renderer : réglages, présence des secrets, état du
 * serveur et de la VM. Chargé au démarrage puis tenu à jour par les events du main.
 */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  AppSettings,
  AppSettingsPatch,
  SandboxProgress,
  SandboxStatus,
  SecretId,
  SecretsPresence,
  SerializedAtelierError,
  ServerStatus,
} from '@atelier/shared';
import { atelier, call, toSerializedError } from '@renderer/lib/api';

export interface AppState {
  settings: AppSettings;
  secrets: SecretsPresence;
  server: ServerStatus;
  sandbox: SandboxStatus;
  /** Dernière progression de préparation de la VM (pendant le provisioning). */
  sandboxProgress: SandboxProgress | undefined;
}

export interface AppActions {
  updateSettings(patch: AppSettingsPatch): Promise<AppSettings>;
  setSecret(id: SecretId, value: string | null): Promise<void>;
}

type Loaded = { status: 'ready'; state: AppState; actions: AppActions };
type AppStateValue =
  | { status: 'loading' }
  | { status: 'error'; error: SerializedAtelierError; retry: () => void }
  | Loaded;

const AppStateContext = createContext<AppStateValue | null>(null);

async function loadInitialState(): Promise<AppState> {
  const [settings, secrets, server, sandbox] = await Promise.all([
    call('settings:get'),
    call('secrets:presence'),
    call('llm:status'),
    call('sandbox:status'),
  ]);
  return { settings, secrets, server, sandbox, sandboxProgress: undefined };
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | undefined>();
  const [error, setError] = useState<SerializedAtelierError | undefined>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadInitialState().then(
      (initial) => {
        if (!cancelled) setState(initial);
      },
      (e: unknown) => {
        if (!cancelled) setError(toSerializedError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const api = atelier();
    const offs = [
      api.on('llm:status', (server) => {
        setState((s) => (s ? { ...s, server } : s));
      }),
      api.on('sandbox:status', (sandbox) => {
        setState((s) => (s ? { ...s, sandbox } : s));
      }),
      api.on('sandbox:progress', (sandboxProgress) => {
        setState((s) => (s ? { ...s, sandboxProgress } : s));
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  const updateSettings = useCallback(async (patch: AppSettingsPatch) => {
    const settings = await call('settings:update', patch);
    setState((s) => (s ? { ...s, settings } : s));
    return settings;
  }, []);

  const setSecret = useCallback(async (id: SecretId, value: string | null) => {
    await call('secrets:set', { id, value });
    const secrets = await call('secrets:presence');
    setState((s) => (s ? { ...s, secrets } : s));
  }, []);

  const value = useMemo<AppStateValue>(() => {
    if (state) return { status: 'ready', state, actions: { updateSettings, setSecret } };
    if (error) {
      return {
        status: 'error',
        error,
        retry: () => {
          setError(undefined);
          setAttempt((n) => n + 1);
        },
      };
    }
    return { status: 'loading' };
  }, [state, error, updateSettings, setSecret]);

  return <AppStateContext value={value}>{children}</AppStateContext>;
}

/** État complet (chargement, erreur ou prêt), pour la racine de l'app. */
export function useAppStatus(): AppStateValue {
  const value = use(AppStateContext);
  if (!value) throw new Error('useAppStatus hors de <AppStateProvider>');
  return value;
}

/** État prêt (à utiliser sous la racine, une fois l'état chargé). */
export function useApp(): Loaded {
  const value = useAppStatus();
  if (value.status !== 'ready') throw new Error('useApp avant le chargement de l’état');
  return value;
}
