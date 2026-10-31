/**
 * Gestionnaires des canaux IPC (`IpcInvokeContract`). Les services sont
 * injectés et Electron n'est pas importé ici : tout est testable sous Node.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { importAttachments } from '@atelier/documents';
import { parseMcpConfigText, type McpManager } from '@atelier/mcp-bridge';
import { testConnection, type FetchFunction } from '@atelier/agent-core';
import { loadSkills } from '@atelier/skills';
import { AtelierError, type AppHealth, type SecretId } from '@atelier/shared';
import type { IpcHandlers } from './ipc.js';
import type { ModelCatalog } from './llm/model-catalog.js';
import type { ServerMonitor } from './llm/server-monitor.js';
import type { ChatManager } from './runtime/chat-manager.js';
import { resolveOpenable } from './safe-open.js';
import type { PermissionBroker } from './runtime/permission-broker.js';
import type { SandboxManager } from './runtime/sandbox-manager.js';
import type { TaskScheduler } from './schedule/task-scheduler.js';
import type { UsageStore } from './runtime/usage-store.js';
import type { SecretsStore } from './settings/secrets-store.js';
import type { SettingsStore } from './settings/settings-store.js';

/** Opérations Electron utilisées par les gestionnaires (injectées). */
export interface DesktopShell {
  chooseDirectory(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  openPath(absolutePath: string): Promise<string>;
  showItemInFolder(absolutePath: string): void;
}

export interface HandlerServices {
  settings: SettingsStore;
  secrets: SecretsStore;
  monitor: ServerMonitor;
  /** Modèles du serveur : liste enrichie et cache des détails (#13). */
  models: Pick<ModelCatalog, 'list'>;
  chats: ChatManager;
  /** Registre de consommation (Réglages › Utilisation) ; absent : statistiques vides. */
  usage?: UsageStore;
  /** Prompts planifiés (ADR-002) ; absent : canaux `schedule:*` non implémentés. */
  scheduler?: Pick<
    TaskScheduler,
    | 'listTasks'
    | 'saveTask'
    | 'deleteTask'
    | 'setEnabled'
    | 'runNow'
    | 'stopRun'
    | 'dashboard'
    | 'runs'
  >;
  permissions: PermissionBroker;
  sandbox: SandboxManager;
  mcp: McpManager;
  shell: DesktopShell;
  /** Un secret a changé (le token LLM impose un nouveau runtime). */
  onSecretChanged?: (id: SecretId) => void;
  home?: string;
  /** État de démarrage (historique persistant ou non). */
  health?: () => AppHealth;
  /** `fetch` des appels de diagnostic (tests). */
  fetch?: FetchFunction;
}

/** Origine normalisée d'une URL (`https://hote:port`), ou `undefined` si invalide. */
export function urlOrigin(raw: string): string | undefined {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return undefined;
  }
}

/**
 * Token à envoyer pour « Tester la connexion ». Le token enregistré ne part que
 * vers l'origine du serveur enregistré : sinon, un renderer compromis pourrait
 * le faire envoyer à un serveur de son choix (`baseUrl` vient du renderer).
 */
export function tokenForConnectionTest(options: {
  requestedUrl: string;
  providedToken: string | undefined;
  savedUrl: string;
  savedToken: string | undefined;
}): string | undefined {
  const provided = options.providedToken?.trim();
  if (provided) return provided;
  const requested = urlOrigin(options.requestedUrl);
  if (requested === undefined || requested !== urlOrigin(options.savedUrl)) return undefined;
  return options.savedToken;
}

/** Contenu proposé quand `mcp.json` n'existe pas encore. */
export const EMPTY_MCP_CONFIG = '{\n  "mcpServers": {}\n}\n';

/** Vrai si `path` est dans `dir` (ou égal). */
export function isWithin(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Dossier de travail acceptable : absolu, existant, ni la racine ni le `$HOME` complet. */
export async function assertWorkspace(dir: string, home: string): Promise<string> {
  if (!isAbsolute(dir)) throw new AtelierError('sandbox/invalid_workspace', 'Chemin non absolu.');
  const normalized = resolve(dir);
  if (normalized === sep || normalized === resolve(home)) {
    throw new AtelierError(
      'sandbox/invalid_workspace',
      'Choisissez un dossier précis : ni la racine du disque ni votre dossier personnel entier.',
    );
  }
  let info;
  try {
    info = await stat(normalized);
  } catch (error) {
    throw new AtelierError('sandbox/invalid_workspace', `Dossier introuvable : ${normalized}`, {
      cause: error,
    });
  }
  if (!info.isDirectory())
    throw new AtelierError('sandbox/invalid_workspace', `Pas un dossier : ${normalized}`);
  return normalized;
}

export function createHandlers(s: HandlerServices): IpcHandlers {
  const home = s.home ?? homedir();

  /** Dossiers de travail des conversations connues (seuls lieux ouvrables). */
  const workspaces = (): string[] => [...new Set(s.chats.list(1000).map((c) => c.workspace))];

  return {
    // --- Application
    'app:health': () => s.health?.() ?? { historyPersistent: true },

    // --- Réglages et secrets
    'settings:get': () => s.settings.get(),
    'settings:update': (patch) => s.settings.update(patch),
    'secrets:set': async ({ id, value }) => {
      await s.secrets.set(id, value);
      s.onSecretChanged?.(id);
      return undefined;
    },
    'secrets:presence': () => s.secrets.presence(),

    // --- Serveur LLM
    'llm:test-connection': ({ baseUrl, token, model }) => {
      const { numCtx, baseUrl: savedUrl } = s.settings.get().llm;
      const effective = tokenForConnectionTest({
        requestedUrl: baseUrl,
        providedToken: token,
        savedUrl,
        savedToken: s.secrets.get('llm_token'),
      });
      return testConnection({
        baseUrl,
        ...(s.fetch ? { fetch: s.fetch } : {}),
        ...(effective ? { token: effective } : {}),
        ...(model ? { model } : {}),
        ...(numCtx !== undefined ? { numCtx } : {}),
      });
    },
    'llm:list-models': () => s.models.list(),
    'llm:status': () => s.monitor.status(),

    // --- Dossiers et sessions
    'workspace:choose': async () => {
      const dir = await s.shell.chooseDirectory();
      return dir === null ? null : assertWorkspace(dir, home);
    },
    'dialog:choose-directory': ({ title, defaultPath }) =>
      s.shell.chooseDirectory({
        ...(title !== undefined ? { title } : {}),
        ...(defaultPath !== undefined ? { defaultPath } : {}),
      }),
    'session:list': ({ limit, includeScheduled }) =>
      s.chats.list(limit, includeScheduled ? { includeScheduled } : {}),
    'session:create': async ({ workspace }) =>
      s.chats.create(await assertWorkspace(workspace, home)),
    'session:open': ({ sessionId }) => s.chats.open(sessionId),
    'session:set-model': ({ sessionId, model }) => s.chats.setModel(sessionId, model),
    'session:delete': async ({ sessionId }) => {
      await s.chats.delete(sessionId);
      return undefined;
    },

    // --- Utilisation (agrégats SQL du registre local, ADR-001)
    'usage:summary': ({ period }) => s.usage?.summary(period) ?? { period, models: [], daily: [] },

    // --- Prompts planifiés (ADR-002)
    ...(s.scheduler ? scheduleHandlers(s.scheduler, home) : {}),

    // --- Agent
    'agent:send': ({ sessionId, text, attachments }) => s.chats.send(sessionId, text, attachments),
    'agent:stop': async ({ sessionId }) => {
      await s.chats.stop(sessionId);
      return undefined;
    },
    'agent:retry': ({ sessionId }) => s.chats.retry(sessionId),
    'permission:respond': ({ requestId, decision }) => {
      s.permissions.respond(requestId, decision);
      return undefined;
    },

    // --- Fichiers
    'attachment:import': ({ sessionId, hostPaths }) => {
      const { session } = s.chats.open(sessionId);
      // Copie dans `.atelier/uploads/`, type détecté par signature (documents).
      return importAttachments(hostPaths, session.workspace);
    },
    'file:open': async ({ absolutePath }) => {
      const message = await s.shell.openPath(
        await resolveOpenable(absolutePath, workspaces(), 'open'),
      );
      if (message !== '') throw new AtelierError('tool/failed', message);
      return undefined;
    },
    'file:reveal': async ({ absolutePath }) => {
      s.shell.showItemInFolder(await resolveOpenable(absolutePath, workspaces(), 'reveal'));
      return undefined;
    },

    // --- Sandbox
    'sandbox:status': () => s.sandbox.status(),
    'sandbox:ensure-ready': async () => {
      await s.sandbox.ensureReady();
      return undefined;
    },
    'sandbox:set-network': async ({ sessionId, enabled }) => {
      await s.sandbox.setNetwork(sessionId, enabled);
      return undefined;
    },
    'sandbox:diagnostics': () => s.sandbox.diagnostics(),
    'sandbox:reset': async () => {
      await s.sandbox.reset();
      return undefined;
    },

    // --- Skills et MCP
    'skills:list': () => loadSkills(s.settings.get().skillsDir),
    'mcp:status': () => ({ servers: s.mcp.status(), issues: s.mcp.config.issues }),
    'mcp:read-config': async () => {
      try {
        return await readFile(s.settings.get().mcpConfigPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_MCP_CONFIG;
        throw new AtelierError('mcp/config_invalid', 'Lecture de mcp.json impossible.', {
          cause: error,
        });
      }
    },
    'mcp:write-config': async ({ json }) => {
      // Valide avant d'écrire : un JSON illisible n'écrase jamais le fichier.
      const config = parseMcpConfigText(json, home);
      const path = s.settings.get().mcpConfigPath;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, json, 'utf8');
      await rename(`${path}.tmp`, path);
      void s.mcp.apply(config);
      return undefined;
    },
  };
}

function scheduleHandlers(
  scheduler: NonNullable<HandlerServices['scheduler']>,
  home: string,
): IpcHandlers {
  return {
    'schedule:list': () => scheduler.listTasks(),
    'schedule:save': async ({ id, task }) =>
      // Même règle de dossier qu'une conversation : ni la racine ni le $HOME entier.
      scheduler.saveTask({ ...task, workspace: await assertWorkspace(task.workspace, home) }, id),
    'schedule:delete': async ({ id }) => {
      await scheduler.deleteTask(id);
      return undefined;
    },
    'schedule:set-enabled': ({ id, enabled }) => scheduler.setEnabled(id, enabled),
    'schedule:run-now': ({ id }) => scheduler.runNow(id),
    'schedule:stop-run': async ({ runId }) => {
      await scheduler.stopRun(runId);
      return undefined;
    },
    'schedule:dashboard': ({ period }) => scheduler.dashboard(period),
    'schedule:runs': (query) => scheduler.runs(query),
  };
}
