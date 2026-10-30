import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, safeStorage, session, shell } from 'electron';
import { checkServerHealth } from '@atelier/agent-core';
import type { AppHealth } from '@atelier/shared';
import { loadMcpConfig, McpManager } from '@atelier/mcp-bridge';
import { LimaSandbox } from '@atelier/sandbox';
import { installExampleSkills } from '@atelier/skills';
import { broadcast } from './broadcast.js';
import { createHandlers } from './handlers.js';
import { registerIpcHandlers } from './ipc.js';
import { ModelCatalog, serverModelSource } from './llm/model-catalog.js';
import { ServerMonitor } from './llm/server-monitor.js';
import { limaPreflight, resolveAppPaths } from './paths.js';
import { AgentRuntimeHost } from './runtime/agent-runtime.js';
import { ChatManager } from './runtime/chat-manager.js';
import { PermissionBroker } from './runtime/permission-broker.js';
import { SandboxManager } from './runtime/sandbox-manager.js';
import { InMemorySessionStore, type SessionStore } from './runtime/session-store.js';
import { openDatabase, SqliteSessionStore } from './runtime/sqlite-store.js';
import { InMemoryUsageStore, SqliteUsageStore, type UsageStore } from './runtime/usage-store.js';
import { SecretsStore } from './settings/secrets-store.js';
import { SettingsStore } from './settings/settings-store.js';

/** Politique de sécurité du contenu stricte (brief §8). */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

const isDev = !app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL']);

function log(message: string, data?: unknown): void {
  if (data === undefined) console.log(`[atelier] ${message}`);
  else console.log(`[atelier] ${message}`, data);
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Atelier',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // Liens externes : navigateur système, jamais de nouvelle fenêtre Electron.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (!(isDev && devUrl && url.startsWith(devUrl))) event.preventDefault();
  });
  // Un fichier déposé hors de la zone de dépôt ne doit jamais remplacer l'app.
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

function installContentSecurityPolicy(): void {
  // En dev, Vite (HMR) a besoin de scripts inline et du websocket : CSP appliquée en production.
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
  // Aucune permission web (caméra, notifications, géolocalisation…) pour le renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
}

/** Assemble les services du process main (agent, VM, MCP, réglages). */
async function bootstrap(): Promise<{ shutdown: () => Promise<void> }> {
  const home = homedir();
  const paths = resolveAppPaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
  });

  const settings = await SettingsStore.load(join(paths.userData, 'settings.json'), home);
  const secrets = await SecretsStore.load(join(paths.userData, 'secrets.json'), safeStorage);

  // Skills d'exemple : copiés une fois, jamais écrasés.
  try {
    await mkdir(settings.get().skillsDir, { recursive: true });
    const installed = await installExampleSkills(paths.skillsExamples, settings.get().skillsDir);
    if (installed.length > 0) log('skills d’exemple installés', installed);
  } catch (error) {
    log('installation des skills d’exemple impossible', error);
  }

  const mcp = new McpManager({
    log: (message: string) => {
      log(`mcp: ${message}`);
    },
  });
  const reloadMcp = async (): Promise<void> => {
    try {
      await mcp.apply(await loadMcpConfig(settings.get().mcpConfigPath, home));
    } catch (error) {
      log('mcp.json illisible', error);
    }
  };
  void reloadMcp();
  mcp.onChange(() => {
    broadcast('mcp:status', { servers: mcp.status(), issues: mcp.config.issues });
  });

  const monitor = new ServerMonitor({
    target: () => {
      const { baseUrl } = settings.get().llm;
      return baseUrl === '' ? undefined : { baseUrl, token: secrets.get('llm_token') };
    },
    probe: (target, signal) =>
      checkServerHealth({
        baseUrl: target.baseUrl,
        signal,
        ...(target.token ? { token: target.token } : {}),
      }),
    onChange: (status, previous) => {
      broadcast('llm:status', status);
      // Serveur revenu : la fenêtre de contexte devinée au démarrage est relue.
      if (status.health !== 'offline' && previous.health === 'offline') {
        void agents.refreshIfFallback();
      }
    },
  });

  const sandbox = new SandboxManager({
    create: () => {
      const s = settings.get();
      return new LimaSandbox({
        limactlPath: paths.limactl,
        templatesDir: paths.limaTemplates,
        skillsDir: s.skillsDir,
        resources: {
          cpus: s.sandbox.cpus,
          memoryGiB: s.sandbox.memoryGiB,
          ...(s.sandbox.diskGiB ? { diskGiB: s.sandbox.diskGiB } : {}),
        },
        networkEnabled: s.sandbox.networkEnabledByDefault,
        log: (message) => {
          log(`vm: ${message}`);
        },
      });
    },
    preflight: () => limaPreflight(paths, app.isPackaged),
    onStatus: (status) => {
      broadcast('sandbox:status', status);
    },
    onProgress: (progress) => {
      broadcast('sandbox:progress', progress);
    },
    defaultNetwork: () => settings.get().sandbox.networkEnabledByDefault,
    log,
  });

  // Modèles du serveur (#13) : capacités et contexte en cache, état chargé relu à chaque liste.
  const models = new ModelCatalog({
    source: serverModelSource(() => {
      const token = secrets.get('llm_token');
      return { baseUrl: settings.get().llm.baseUrl, ...(token ? { token } : {}) };
    }),
    numCtx: () => settings.get().llm.numCtx,
  });

  const agents = new AgentRuntimeHost({
    settings: () => settings.get(),
    secret: (id) => secrets.get(id),
    sandbox,
    mcp,
    capabilities: (model) => models.capabilities(model),
    log: (message, data) => {
      log(`agent: ${message}`, data);
    },
  });

  // Historique persistant ; si la base est inutilisable, l'app reste utilisable (en mémoire).
  // Même base pour le registre de consommation (ADR-001) : statistiques locales uniquement.
  let store: SessionStore;
  let usage: UsageStore;
  let health: AppHealth = { historyPersistent: true };
  try {
    const db = await openDatabase(join(paths.userData, 'atelier.db'));
    store = new SqliteSessionStore(db);
    usage = new SqliteUsageStore(db);
  } catch (error) {
    log('historique SQLite indisponible, conversations gardées en mémoire', error);
    store = new InMemorySessionStore();
    usage = new InMemoryUsageStore();
    health = {
      historyPersistent: false,
      historyError: error instanceof Error ? error.message : String(error),
    };
  }

  const permissions = new PermissionBroker();
  const chats = new ChatManager({
    store,
    permissions,
    agents,
    emit: (event) => {
      broadcast('agent:event', event);
    },
    onLlmError: () => {
      void monitor.check();
    },
    usage,
    defaultModel: () => settings.get().llm.model,
    models,
    log,
  });

  settings.onChange((next, previous) => {
    // Le modèle par défaut n'invalide aucun runtime (un par modèle) : seules les
    // conversations qui le suivent changent de session agent au tour suivant.
    if (
      next.llm.baseUrl !== previous.llm.baseUrl ||
      next.llm.numCtx !== previous.llm.numCtx ||
      next.llm.thinking !== previous.llm.thinking ||
      next.llm.visionModel !== previous.llm.visionModel
    ) {
      agents.invalidate();
      void monitor.check();
    }
    if (next.llm.baseUrl !== previous.llm.baseUrl) models.clear();
    if (next.mcpConfigPath !== previous.mcpConfigPath) void reloadMcp();
    if (next.onboardingCompleted && !previous.onboardingCompleted) monitor.start();
  });

  registerIpcHandlers(
    createHandlers({
      settings,
      secrets,
      monitor,
      models,
      chats,
      usage,
      permissions,
      sandbox,
      mcp,
      home,
      health: () => health,
      onSecretChanged: (id) => {
        if (id !== 'llm_token') return;
        agents.invalidate();
        models.clear();
        void monitor.check();
      },
      shell: {
        chooseDirectory: async (request) => {
          const window = BrowserWindow.getFocusedWindow();
          const options: Electron.OpenDialogOptions = {
            title: request?.title ?? 'Choisir le dossier de travail',
            ...(request?.defaultPath ? { defaultPath: request.defaultPath } : {}),
            buttonLabel: 'Choisir',
            properties: ['openDirectory', 'createDirectory'],
          };
          const result = window
            ? await dialog.showOpenDialog(window, options)
            : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        openPath: (path) => shell.openPath(path),
        showItemInFolder: (path) => {
          shell.showItemInFolder(path);
        },
      },
    }),
  );

  if (settings.get().onboardingCompleted) {
    monitor.start();
    sandbox.startInBackground();
  }

  return {
    shutdown: async () => {
      monitor.stop();
      await chats.stopAll();
      await Promise.allSettled([mcp.stop(), sandbox.stop()]);
      store.close?.();
    },
  };
}

let shutdown: (() => Promise<void>) | undefined;
let quitting = false;

void app.whenReady().then(async () => {
  app.setName('Atelier');
  installContentSecurityPolicy();
  ({ shutdown } = await bootstrap());
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Arrêt propre : tours annulés, connecteurs MCP fermés, VM arrêtée.
app.on('before-quit', (event) => {
  if (quitting || !shutdown) return;
  event.preventDefault();
  quitting = true;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 20_000));
  void Promise.race([shutdown(), timeout]).finally(() => {
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
