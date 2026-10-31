import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import {
  checkServerHealth,
  UNATTENDED_INSTRUCTIONS,
  unattendedPermissionHandler,
} from '@atelier/agent-core';
import {
  ARTIFACT_SCHEME,
  type AppHealth,
  type ScheduledRun,
  type ScheduledTask,
} from '@atelier/shared';
import { loadMcpConfig, McpManager } from '@atelier/mcp-bridge';
import { defaultLimaHome, fallbackLimaHome, LimaSandbox } from '@atelier/sandbox';
import { installExampleSkills } from '@atelier/skills';
import { broadcast } from './broadcast.js';
import { handlePreviewRequest, PREVIEW_SCHEME } from './file-preview.js';
import { createHandlers } from './handlers.js';
import { registerIpcHandlers } from './ipc.js';
import { ModelCatalog, serverModelSource } from './llm/model-catalog.js';
import { ServerMonitor } from './llm/server-monitor.js';
import { limaPreflight, resolveAppPaths } from './paths.js';
import { AgentRuntimeHost } from './runtime/agent-runtime.js';
import { ChatManager } from './runtime/chat-manager.js';
import {
  handleArtifactRequest,
  isAllowedSubframeUrl,
  type ArtifactLibraries,
} from './projects/artifact-protocol.js';
import {
  InMemoryArtifactStore,
  SqliteArtifactStore,
  type ArtifactStore,
} from './projects/artifact-store.js';
import { ProjectService } from './projects/project-service.js';
import {
  InMemoryProjectStore,
  SqliteProjectStore,
  type ProjectStore,
} from './projects/project-store.js';
import { PermissionBroker } from './runtime/permission-broker.js';
import { SandboxManager } from './runtime/sandbox-manager.js';
import { InMemorySessionStore, type SessionStore } from './runtime/session-store.js';
import { openDatabase, SqliteSessionStore } from './runtime/sqlite-store.js';
import { InMemoryUsageStore, SqliteUsageStore, type UsageStore } from './runtime/usage-store.js';
import {
  InMemoryScheduleStore,
  SqliteScheduleStore,
  type ScheduleStore,
} from './schedule/schedule-store.js';
import { runNotificationBody } from './schedule/notifications.js';
import { ScheduledRunner } from './schedule/scheduled-runner.js';
import { TaskScheduler } from './schedule/task-scheduler.js';
import { WorkspaceLease } from './schedule/workspace-lease.js';
import { SecretsStore } from './settings/secrets-store.js';
import { SettingsStore } from './settings/settings-store.js';

/** Politique de sécurité du contenu stricte (brief §8). */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // atelier-file: aperçu des fichiers de la conversation (voir file-preview.ts).
  `img-src 'self' data: blob: ${PREVIEW_SCHEME}:`,
  "font-src 'self' data:",
  // atelier-artifact: pages publiées par l'agent (ADR-003 D5), dans une iframe isolée.
  `connect-src 'self' ${PREVIEW_SCHEME}: ${ARTIFACT_SCHEME}:`,
  `frame-src ${PREVIEW_SCHEME}: ${ARTIFACT_SCHEME}:`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

// Protocoles d'aperçu et d'artefacts : à déclarer avant `ready` (fetch, flux,
// visionneuse PDF, pages publiées).
protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  {
    scheme: ARTIFACT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/** Chart.js servi localement aux artefacts (jamais de CDN, ADR-003 D5). */
function artifactLibraries(): ArtifactLibraries {
  try {
    // `exports` ne publie pas le fichier UMD : on part de l'entrée du paquet.
    const entry = createRequire(import.meta.url).resolve('chart.js');
    return { 'chart.umd.min.js': join(dirname(entry), 'chart.umd.min.js') };
  } catch {
    return {};
  }
}

/** Identifiant fixe de la visionneuse PDF intégrée de Chromium / Electron. */
const PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

const isDev = !app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL']);

function log(message: string, data?: unknown): void {
  if (data === undefined) console.log(`[atelier] ${message}`);
  else console.log(`[atelier] ${message}`, data);
}

/** Montre la fenêtre, créée au besoin (app ouverte à la connexion, fenêtre fermée). */
function revealWindow(): BrowserWindow {
  const window = BrowserWindow.getAllWindows()[0] ?? createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  return window;
}

/** Délai laissé au renderer d'une fenêtre neuve pour s'abonner aux événements. */
const RENDERER_READY_DELAY_MS = 1_500;

/** Ouvre la conversation d'un run dans la fenêtre (clic sur la notification, D7). */
function openRunSession(sessionId: string): void {
  const window = revealWindow();
  const send = (): void => {
    broadcast('app:open-session', { sessionId });
  };
  if (!window.webContents.isLoading()) {
    send();
    return;
  }
  // Fenêtre neuve : le renderer s'abonne après son chargement et celui des réglages.
  // Ouvrir deux fois la même conversation est sans effet.
  window.webContents.once('did-finish-load', () => {
    send();
    setTimeout(send, RENDERER_READY_DELAY_MS);
  });
}

function notifyRun(task: ScheduledTask, run: ScheduledRun): void {
  if (!Notification.isSupported()) return;
  // Silencieuse et sans `focus` : une erreur de run ne vole jamais le focus.
  const notification = new Notification({
    title: task.name,
    body: runNotificationBody(run),
    silent: run.status === 'success',
  });
  notification.on('click', () => {
    if (run.sessionId) openRunSession(run.sessionId);
    else revealWindow();
  });
  notification.show();
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
    // Fond du thème courant (jeton --background du renderer) : pas de flash blanc en mode sombre.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      // Visionneuse PDF intégrée de Chromium (aperçu des PDF dans le panneau droit).
      plugins: true,
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
  // Sous-cadres (artefacts, aperçu) : jamais vers le web. Sans ce garde-fou, une
  // page publiée piégée pourrait s'envoyer vers https://…?données (ADR-003 D5).
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    const allowed = isAllowedSubframeUrl(event.url, [
      `${PREVIEW_SCHEME}:`,
      `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/`,
    ]);
    if (!allowed) event.preventDefault();
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
    // L'aperçu (atelier-file:) fixe sa propre CSP ; la visionneuse PDF de Chromium
    // (extension interne) doit pouvoir s'afficher dans l'iframe d'aperçu.
    if (
      details.url.startsWith(`${PREVIEW_SCHEME}:`) ||
      // Les artefacts portent leur propre CSP (sans réseau, `sandbox allow-scripts`).
      details.url.startsWith(`${ARTIFACT_SCHEME}:`) ||
      details.url.startsWith(`chrome-extension://${PDF_VIEWER_EXTENSION_ID}/`)
    ) {
      callback({});
      return;
    }
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

  // Bail de la VM partagé par les tours interactifs et les runs planifiés (ADR-002 D5).
  const lease = new WorkspaceLease({
    onChange: () => {
      sandbox.holderChanged();
    },
  });

  const sandbox = new SandboxManager({
    holder: () => lease.holder(),
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
  let schedules: ScheduleStore;
  let projectStore: ProjectStore;
  let artifactStore: ArtifactStore;
  let health: AppHealth = { historyPersistent: true };
  try {
    const db = await openDatabase(join(paths.userData, 'atelier.db'));
    store = new SqliteSessionStore(db);
    usage = new SqliteUsageStore(db);
    schedules = new SqliteScheduleStore(db);
    projectStore = new SqliteProjectStore(db);
    artifactStore = new SqliteArtifactStore(db);
  } catch (error) {
    log('historique SQLite indisponible, conversations gardées en mémoire', error);
    store = new InMemorySessionStore();
    usage = new InMemoryUsageStore();
    schedules = new InMemoryScheduleStore();
    projectStore = new InMemoryProjectStore();
    artifactStore = new InMemoryArtifactStore();
    health = {
      historyPersistent: false,
      historyError: error instanceof Error ? error.message : String(error),
    };
  }

  // Projets (ADR-003) : conversations et tâches sont branchées plus bas (fonctions).
  const late: { chats?: ChatManager; scheduler?: TaskScheduler } = {};
  const projects = new ProjectService({
    store: projectStore,
    artifacts: artifactStore,
    sessions: store,
    projectsDir: () => settings.get().projectsDir ?? join(home, 'Atelier', 'Projets'),
    home,
    // Jamais un dossier qui contient (ou est dans) les données de la VM, de l'app ou les skills.
    forbiddenRoots: () => [
      defaultLimaHome(home),
      fallbackLimaHome(home),
      paths.userData,
      settings.get().skillsDir,
    ],
    deleteSession: (sessionId) => late.chats?.delete(sessionId) ?? Promise.resolve(),
    tasks: () => {
      const scheduler = late.scheduler;
      if (!scheduler) return undefined;
      return {
        list: () => scheduler.listTasks(),
        setEnabled: (id, enabled) => scheduler.setEnabled(id, enabled),
        delete: (id) => scheduler.deleteTask(id),
        retarget: (id, workspace) => {
          const task = schedules.getTask(id);
          if (!task) return;
          const {
            lastRun: _lastRun,
            nextRunAt: _nextRunAt,
            id: _id,
            createdAt: _createdAt,
            updatedAt: _updatedAt,
            ...input
          } = task;
          scheduler.saveTask({ ...input, workspace }, id);
        },
      };
    },
    runOf: (sessionId) => {
      const taskId = store.get(sessionId)?.scheduledTaskId;
      if (taskId === undefined) return undefined;
      const run = schedules.openRuns(taskId).find((r) => r.sessionId === sessionId);
      const task = schedules.getTask(taskId);
      return run && task ? { runId: run.id, taskName: task.name } : undefined;
    },
    onProjectChanged: (projectId) => {
      broadcast('project:changed', { projectId });
    },
    onArtifactChanged: (artifact, deleted) => {
      broadcast('artifact:changed', { artifact, ...(deleted ? { deleted } : {}) });
    },
  });

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
    lease,
    projects,
    log,
  });
  late.chats = chats;

  // Prompts planifiés (ADR-002) : un run à la fois, permissions non interactives.
  const runner = new ScheduledRunner({
    chats,
    lease,
    permissionHandler: unattendedPermissionHandler,
    instructions: UNATTENDED_INSTRUCTIONS,
    // Tâche de projet : le bail couvre les dossiers rattachés montés (ADR-003 D6).
    leaseFor: (task) => projects.leaseFor(task),
    // Pas d'App Nap pendant un run ; la mise en veille du Mac reste possible (rattrapage).
    keepAwake: () => {
      const id = powerSaveBlocker.start('prevent-app-suspension');
      return () => {
        powerSaveBlocker.stop(id);
      };
    },
  });
  const scheduler = new TaskScheduler({
    store: schedules,
    execute: (request) => runner.execute(request),
    onChange: (change) => {
      broadcast('schedule:changed', change);
    },
    onFinished: notifyRun,
    log,
  });
  late.scheduler = scheduler;
  // Réveil ou déverrouillage du Mac : une exécution par tâche en retard.
  powerMonitor.on('resume', () => {
    scheduler.catchUp();
  });
  powerMonitor.on('unlock-screen', () => {
    scheduler.catchUp();
  });
  const applyOpenAtLogin = (enabled: boolean): void => {
    // En développement, l'exécutable est celui d'Electron : on ne touche à rien.
    if (!app.isPackaged) return;
    // Fenêtre masquée : au lancement, `wasOpenedAtLogin` évite de l'ouvrir (voir plus bas).
    app.setLoginItemSettings({ openAtLogin: enabled });
  };
  applyOpenAtLogin(settings.get().openAtLogin === true);

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
    if (next.openAtLogin !== previous.openAtLogin) applyOpenAtLogin(next.openAtLogin === true);
  });

  // Aperçu : seulement les fichiers des dossiers des conversations et des projets connus.
  protocol.handle(PREVIEW_SCHEME, (request) =>
    handlePreviewRequest(request.url, [
      ...new Set([
        ...chats.list(1000, { includeScheduled: true }).map((c) => c.workspace),
        ...projects.openableRoots(),
      ]),
    ]),
  );
  // Artefacts publiés (ADR-003 D5) : versions servies depuis la base, isolées.
  const libraries = artifactLibraries();
  protocol.handle(ARTIFACT_SCHEME, (request) =>
    handleArtifactRequest(request.url, artifactStore, libraries),
  );

  registerIpcHandlers(
    createHandlers({
      settings,
      secrets,
      monitor,
      models,
      chats,
      usage,
      scheduler,
      permissions,
      projects,
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
  // Runs interrompus (app tuée), purge à 90 jours, rattrapage, puis minuteur.
  scheduler.start();

  return {
    shutdown: async () => {
      monitor.stop();
      scheduler.stop();
      await chats.stopAll();
      await Promise.allSettled([mcp.stop(), sandbox.stop()]);
      store.close?.();
    },
  };
}

let shutdown: (() => Promise<void>) | undefined;
let quitting = false;

// Une seule instance par dossier de données : une deuxième partagerait la VM
// et l'arrêterait en quittant (`limactl stop`), en pleine session de la
// première. Elle s'efface au profit de la fenêtre existante.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);

let revealRequested = false;
app.on('second-instance', () => {
  if (quitting) return;
  // Démarrage en cours : la fenêtre s'ouvrira à la fin de `bootstrap`.
  if (shutdown) revealWindow();
  else revealRequested = true;
});

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  app.setName('Atelier');
  installContentSecurityPolicy();
  ({ shutdown } = await bootstrap());
  // Ouverte à la connexion (tâches planifiées) : l'app tourne sans fenêtre ;
  // l'icône du Dock (`activate`) ou une notification l'affichent.
  if (!app.getLoginItemSettings().wasOpenedAtLogin || revealRequested) createMainWindow();

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
