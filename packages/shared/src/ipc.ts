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
import type { Attachment, ChatMessage, SessionSummary, TokenUsage } from './messages.js';
import type { ConnectionTestResult, LlmModelInfo, ServerStatus } from './llm.js';
import type { McpStatus } from './mcp.js';
import type { PermissionDecision } from './permissions.js';
import type { SandboxDiagnostics, SandboxProgress, SandboxStatus } from './sandbox.js';
import type { AppSettings, AppSettingsPatch, SecretId, SecretsPresence } from './settings.js';
import type { SkillInfo } from './skills.js';
import type { UsagePeriod, UsageSummary } from './usage.js';

/** Résultat d'un appel IPC : jamais d'exception qui traverse le pont, toujours un résultat typé. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedAtelierError };

/**
 * État de santé de l'application, fixé au démarrage : signale les modes
 * dégradés à l'utilisateur (bandeau). Extensible à d'autres dégradations.
 */
export interface AppHealth {
  /** Faux si l'historique est tenu en mémoire (base SQLite inutilisable) : rien ne sera conservé. */
  historyPersistent: boolean;
  /** Raison technique de la dégradation de l'historique (diagnostic, pas pour l'affichage brut). */
  historyError?: string;
}

/** Canaux renderer → main, avec requête et réponse typées. */
export interface IpcInvokeContract {
  // --- Application
  'app:health': { request: undefined; response: AppHealth };

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
  /** Sélecteur de dossier générique (ex. dossier des skills) ; `null` si annulé. */
  'dialog:choose-directory': {
    request: { title?: string; defaultPath?: string };
    response: string | null;
  };
  'session:list': { request: { limit?: number }; response: SessionSummary[] };
  'session:create': { request: { workspace: string }; response: SessionSummary };
  'session:open': {
    request: { sessionId: string };
    response: {
      session: SessionSummary;
      messages: ChatMessage[];
      /** Dernier usage connu de la session (jauge de contexte dès la réouverture). */
      usage?: TokenUsage;
    };
  };
  'session:delete': { request: { sessionId: string }; response: undefined };
  /**
   * Change le modèle de la conversation (pris en compte au tour suivant).
   * `null` : revenir au modèle par défaut des Réglages.
   */
  'session:set-model': {
    request: { sessionId: string; model: string | null };
    response: SessionSummary;
  };

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
  /**
   * Copie des fichiers glissés dans `<dossier>/.atelier/uploads/`.
   * ⚠️ Réservé au preload ({@link AtelierApi.importDroppedFiles}) : le renderer
   * ne peut pas l'appeler directement, il ne fournit jamais de chemin arbitraire.
   */
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
  'mcp:status': { request: undefined; response: McpStatus };

  // --- Utilisation (tokens par modèle, KPI)
  'usage:summary': { request: { period: UsagePeriod }; response: UsageSummary };
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
  /** Changement d'état des connecteurs MCP. */
  'mcp:status': McpStatus;
}

/** Canal d'événement. */
export type IpcEventChannel = keyof IpcEventContract;
/** Charge utile d'un canal d'événement. */
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C];

/** Liste exhaustive des canaux d'invocation (le preload refuse tout autre canal). */
export const IPC_INVOKE_CHANNELS = [
  'app:health',
  'settings:get',
  'settings:update',
  'secrets:set',
  'secrets:presence',
  'llm:test-connection',
  'llm:list-models',
  'llm:status',
  'workspace:choose',
  'dialog:choose-directory',
  'session:list',
  'session:create',
  'session:open',
  'session:delete',
  'session:set-model',
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
  'mcp:status',
  'usage:summary',
] as const satisfies readonly IpcInvokeChannel[];

/** Liste exhaustive des canaux d'événements. */
export const IPC_EVENT_CHANNELS = [
  'agent:event',
  'sandbox:progress',
  'sandbox:status',
  'llm:status',
  'mcp:status',
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

/** Canaux réservés au preload : le renderer ne peut pas les invoquer directement. */
export const IPC_PRELOAD_ONLY_CHANNELS = [
  'attachment:import',
] as const satisfies readonly IpcInvokeChannel[];

/** Canal invocable par le renderer via {@link AtelierApi.invoke}. */
export type RendererInvokeChannel = Exclude<
  IpcInvokeChannel,
  (typeof IPC_PRELOAD_ONLY_CHANNELS)[number]
>;

/** Canaux que le preload laisse passer depuis le renderer. */
export const IPC_RENDERER_INVOKE_CHANNELS: readonly RendererInvokeChannel[] =
  IPC_INVOKE_CHANNELS.filter(
    (channel): channel is RendererInvokeChannel =>
      !(IPC_PRELOAD_ONLY_CHANNELS as readonly string[]).includes(channel),
  );

/** Fonction de désabonnement. */
export type Unsubscribe = () => void;

/**
 * API exposée au renderer sur `window.atelier` par le preload.
 * Les appels renvoient un {@link IpcResult} : le renderer gère les erreurs sans try/catch.
 */
export interface AtelierApi {
  /** Appelle un canal du main (sauf les canaux réservés au preload). */
  invoke<C extends RendererInvokeChannel>(
    channel: C,
    ...args: IpcRequest<C> extends undefined ? [] : [request: IpcRequest<C>]
  ): Promise<IpcResult<IpcResponse<C>>>;
  /** S'abonne à un canal d'événements du main. */
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void,
  ): Unsubscribe;
  /**
   * Importe des fichiers glissés-déposés dans la session (copie dans
   * `<dossier>/.atelier/uploads/`). Le preload résout lui-même les chemins
   * (`webUtils.getPathForFile`, `File.path` n'existe plus depuis Electron 32) :
   * le renderer ne manipule jamais de chemin hôte. Un `File` construit en
   * mémoire (sans fichier sur disque) est refusé.
   */
  importDroppedFiles(
    sessionId: string,
    files: readonly File[],
  ): Promise<IpcResult<IpcResponse<'attachment:import'>>>;
  /** Informations de plateforme non sensibles. */
  readonly platform: { os: 'darwin'; arch: 'arm64' | 'x64'; appVersion: string };
}
