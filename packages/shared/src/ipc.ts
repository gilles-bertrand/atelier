/**
 * Contrats IPC Electron entre le process main et le renderer.
 *
 * - {@link IpcInvokeContract} : requêtes renderer → main (`ipcRenderer.invoke`),
 *   une entrée par canal avec ses types de requête et de réponse.
 * - {@link IpcEventContract} : notifications main → renderer (`webContents.send`).
 * - {@link AtelierApi} : API exposée par le preload sur `window.atelier`
 *   (`contextBridge.exposeInMainWorld`). Le renderer n'a jamais accès à Node.
 *
 * Ce module est purement typé (plus quelques constantes) : il peut être importé
 * par le renderer sans tirer de dépendance Node.
 */
import type { SerializedAtelierError } from './errors.js';
import type { AgentEvent } from './events.js';
import type { Attachment, ChatMessage, SessionSummary } from './messages.js';
import type { ConnectionTestResult, LlmModelInfo, ServerStatus } from './llm.js';
import type { PermissionDecision } from './permissions.js';
import type { SandboxDiagnostics, SandboxProgress, SandboxStatus } from './sandbox.js';
import type { AppSettings, AppSettingsPatch, SecretId, SecretsPresence } from './settings.js';
import type { SkillInfo } from './skills.js';

/** Résultat d'un appel IPC : jamais d'exception qui traverse le pont, toujours un résultat typé. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedAtelierError };

/** Canaux renderer → main, avec requête et réponse typées. */
export interface IpcInvokeContract {
  // --- Réglages et secrets
  'settings:get': { request: undefined; response: AppSettings };
  'settings:update': { request: AppSettingsPatch; response: AppSettings };
  'secrets:set': { request: { id: SecretId; value: string | null }; response: undefined };
  'secrets:presence': { request: undefined; response: SecretsPresence };

  // --- Serveur LLM
  'llm:test-connection': {
    request: { baseUrl: string; token?: string; model?: string };
    response: ConnectionTestResult;
  };
  'llm:list-models': { request: undefined; response: LlmModelInfo[] };
  'llm:status': { request: undefined; response: ServerStatus };

  // --- Dossiers et sessions
  'workspace:choose': { request: undefined; response: string | null };
  'session:list': { request: { limit?: number }; response: SessionSummary[] };
  'session:create': { request: { workspace: string }; response: SessionSummary };
  'session:open': {
    request: { sessionId: string };
    response: { session: SessionSummary; messages: ChatMessage[] };
  };
  'session:delete': { request: { sessionId: string }; response: undefined };

  // --- Agent
  'agent:send': {
    request: { sessionId: string; text: string; attachments?: Attachment[] };
    response: { turnId: string };
  };
  'agent:stop': { request: { sessionId: string }; response: undefined };
  'agent:retry': { request: { sessionId: string }; response: { turnId: string } };
  'permission:respond': {
    request: { requestId: string; decision: PermissionDecision };
    response: undefined;
  };

  // --- Fichiers
  'attachment:import': {
    request: { sessionId: string; hostPaths: string[] };
    response: Attachment[];
  };
  'file:open': { request: { absolutePath: string }; response: undefined };
  'file:reveal': { request: { absolutePath: string }; response: undefined };

  // --- Sandbox
  'sandbox:status': { request: undefined; response: SandboxStatus };
  'sandbox:ensure-ready': { request: undefined; response: undefined };
  'sandbox:set-network': { request: { sessionId: string; enabled: boolean }; response: undefined };
  'sandbox:diagnostics': { request: undefined; response: SandboxDiagnostics };
  'sandbox:reset': { request: undefined; response: undefined };

  // --- Skills et MCP
  'skills:list': { request: undefined; response: SkillInfo[] };
  'mcp:read-config': { request: undefined; response: string };
  'mcp:write-config': { request: { json: string }; response: undefined };
}

/** Canal d'invocation. */
export type IpcInvokeChannel = keyof IpcInvokeContract;
/** Type de requête d'un canal. */
export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeContract[C]['request'];
/** Type de réponse d'un canal. */
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeContract[C]['response'];

/** Notifications main → renderer. */
export interface IpcEventContract {
  /** Événement de la boucle agentique. */
  'agent:event': AgentEvent;
  /** Progression de la préparation de la VM. */
  'sandbox:progress': SandboxProgress;
  /** Changement d'état de la VM. */
  'sandbox:status': SandboxStatus;
  /** Changement d'état du serveur LLM. */
  'llm:status': ServerStatus;
}

/** Canal d'événement. */
export type IpcEventChannel = keyof IpcEventContract;
/** Charge utile d'un canal d'événement. */
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C];

/** Liste exhaustive des canaux d'invocation (le preload refuse tout autre canal). */
export const IPC_INVOKE_CHANNELS = [
  'settings:get',
  'settings:update',
  'secrets:set',
  'secrets:presence',
  'llm:test-connection',
  'llm:list-models',
  'llm:status',
  'workspace:choose',
  'session:list',
  'session:create',
  'session:open',
  'session:delete',
  'agent:send',
  'agent:stop',
  'agent:retry',
  'permission:respond',
  'attachment:import',
  'file:open',
  'file:reveal',
  'sandbox:status',
  'sandbox:ensure-ready',
  'sandbox:set-network',
  'sandbox:diagnostics',
  'sandbox:reset',
  'skills:list',
  'mcp:read-config',
  'mcp:write-config',
] as const satisfies readonly IpcInvokeChannel[];

/** Liste exhaustive des canaux d'événements. */
export const IPC_EVENT_CHANNELS = [
  'agent:event',
  'sandbox:progress',
  'sandbox:status',
  'llm:status',
] as const satisfies readonly IpcEventChannel[];

// Vérifications à la compilation : les listes couvrent exactement les contrats.
type Missing<All, Listed> = Exclude<All, Listed>;
export const _invokeExhaustive: Missing<
  IpcInvokeChannel,
  (typeof IPC_INVOKE_CHANNELS)[number]
> extends never
  ? true
  : false = true;
export const _eventExhaustive: Missing<
  IpcEventChannel,
  (typeof IPC_EVENT_CHANNELS)[number]
> extends never
  ? true
  : false = true;

/** Fonction de désabonnement. */
export type Unsubscribe = () => void;

/**
 * API exposée au renderer sur `window.atelier` par le preload.
 * Les appels renvoient un {@link IpcResult} : le renderer gère les erreurs sans try/catch.
 */
export interface AtelierApi {
  /** Appelle un canal du main. */
  invoke<C extends IpcInvokeChannel>(
    channel: C,
    ...args: IpcRequest<C> extends undefined ? [] : [request: IpcRequest<C>]
  ): Promise<IpcResult<IpcResponse<C>>>;
  /** S'abonne à un canal d'événements du main. */
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void,
  ): Unsubscribe;
  /** Informations de plateforme non sensibles. */
  readonly platform: { os: 'darwin'; arch: 'arm64' | 'x64'; appVersion: string };
}
