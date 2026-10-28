/**
 * Gestionnaires des canaux IPC (`IpcInvokeContract`). Les services sont
 * injectés et Electron n'est pas importé ici : tout est testable sous Node.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseMcpConfigText, type McpManager } from '@atelier/mcp-bridge';
import { listModels, testConnection, type FetchFunction } from '@atelier/agent-core';
import { loadSkills } from '@atelier/skills';
import { AtelierError, type SecretId } from '@atelier/shared';
import type { IpcHandlers } from './ipc.js';
import type { ServerMonitor } from './llm/server-monitor.js';
import type { ChatManager } from './runtime/chat-manager.js';
import { importAttachments } from './runtime/attachments.js';
import type { PermissionBroker } from './runtime/permission-broker.js';
import type { SandboxManager } from './runtime/sandbox-manager.js';
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
  chats: ChatManager;
  permissions: PermissionBroker;
  sandbox: SandboxManager;
  mcp: McpManager;
  shell: DesktopShell;
  /** Un secret a changé (le token LLM impose un nouveau runtime). */
  onSecretChanged?: (id: SecretId) => void;
  home?: string;
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

/**
 * Extensions jamais ouvertes par `file:open` : `shell.openPath` lancerait
 * l'application ou le script (un fichier créé par l'agent n'est pas sûr).
 */
const BLOCKED_OPEN_EXTENSIONS = new Set([
  '.app',
  '.command',
  '.tool',
  '.sh',
  '.zsh',
  '.bash',
  '.terminal',
  '.pkg',
  '.mpkg',
  '.scpt',
  '.scptd',
  '.applescript',
  '.workflow',
  '.action',
  '.jar',
  '.webloc',
  '.inetloc',
  '.fileloc',
]);

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

  /** Un fichier ne s'ouvre que s'il est dans le dossier d'une session connue. */
  const assertOpenable = (absolutePath: string, forLaunch: boolean): string => {
    const path = resolve(absolutePath);
    const known = s.chats.list(1000).some((session) => isWithin(session.workspace, path));
    if (!known) {
      throw new AtelierError(
        'tool/path_outside_workspace',
        `Fichier hors des dossiers de travail : ${path}`,
      );
    }
    if (forLaunch && BLOCKED_OPEN_EXTENSIONS.has(extname(path).toLowerCase())) {
      throw new AtelierError(
        'tool/failed',
        'Par sécurité, Atelier n’ouvre pas les applications ni les scripts : utilisez « Afficher dans le Finder ».',
        { details: { kind: 'blocked_open' } },
      );
    }
    return path;
  };

  return {
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
    'llm:list-models': async () => {
      const token = s.secrets.get('llm_token');
      const { models } = await listModels({
        baseUrl: s.settings.get().llm.baseUrl,
        ...(token ? { token } : {}),
      });
      return models;
    },
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
    'session:list': ({ limit }) => s.chats.list(limit),
    'session:create': async ({ workspace }) =>
      s.chats.create(await assertWorkspace(workspace, home)),
    'session:open': ({ sessionId }) => s.chats.open(sessionId),
    'session:delete': async ({ sessionId }) => {
      await s.chats.delete(sessionId);
      return undefined;
    },

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
      return importAttachments(session.workspace, hostPaths);
    },
    'file:open': async ({ absolutePath }) => {
      const message = await s.shell.openPath(assertOpenable(absolutePath, true));
      if (message !== '') throw new AtelierError('tool/failed', message);
      return undefined;
    },
    'file:reveal': ({ absolutePath }) => {
      s.shell.showItemInFolder(assertOpenable(absolutePath, false));
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
