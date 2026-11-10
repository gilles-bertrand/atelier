/**
 * Gestionnaires des canaux IPC (`IpcInvokeContract`). Les services sont
 * injectés et Electron n'est pas importé ici : tout est testable sous Node.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { assertWorkspace } from './workspace-rules.js';
import { importAttachments } from '@atelier/documents';
import { parseMcpConfigText, type McpManager } from '@atelier/mcp-bridge';
import { testConnection, type FetchFunction } from '@atelier/agent-core';
import { loadSkills } from '@atelier/skills';
import { AtelierError, checkSessionMove, type AppHealth, type SecretId } from '@atelier/shared';
import type { IpcCallContext, IpcHandlers } from './ipc.js';
import type { ModelCatalog } from './llm/model-catalog.js';
import type { ServerMonitor } from './llm/server-monitor.js';
import type { ChatManager } from './runtime/chat-manager.js';
import { resolveOpenable } from './safe-open.js';
import type { PermissionBroker } from './runtime/permission-broker.js';
import type { ProjectService } from './projects/project-service.js';
import type { SandboxManager } from './runtime/sandbox-manager.js';
import type { TaskScheduler } from './schedule/task-scheduler.js';
import type { UsageStore } from './runtime/usage-store.js';
import type { SecretsStore } from './settings/secrets-store.js';
import type { SettingsStore } from './settings/settings-store.js';
import type { VoiceService } from './voice/voice-service.js';

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
  /** Projets et artefacts (ADR-003) ; absent : canaux `project:*` et `artifact:*` non implémentés. */
  projects?: ProjectService;
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
  /** Voix locale (ADR-004) ; absente : canaux `voice:*` non implémentés. */
  voice?: VoiceService;
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

/** Règle des dossiers de travail (déplacée dans `workspace-rules.ts`, ADR-003). */
export { assertWorkspace } from './workspace-rules.js';

export function createHandlers(s: HandlerServices): IpcHandlers {
  const home = s.home ?? homedir();

  /**
   * Dossiers des conversations connues (runs planifiés compris : leurs artefacts
   * doivent pouvoir s'afficher dans le Finder) et des projets : seuls lieux ouvrables.
   */
  const workspaces = (): string[] => [
    ...new Set([
      ...s.chats.list(1000, { includeScheduled: true }).map((c) => c.workspace),
      ...(s.projects?.openableRoots() ?? []),
    ]),
  ];

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
    'session:list': ({ limit, includeScheduled, projectId }) =>
      s.chats.list(limit, {
        ...(includeScheduled ? { includeScheduled } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      }),
    'session:create': async ({ workspace, projectId }) => {
      if (projectId === undefined || !s.projects) {
        return s.chats.create(await assertWorkspace(workspace, home));
      }
      // Conversation de projet : toujours dans son dossier principal (ADR-003).
      const project = s.projects.get(projectId);
      if (project.archivedAt !== undefined) {
        throw new AtelierError(
          'project/invalid',
          'Ce projet est archivé : désarchivez-le d’abord.',
          {
            details: { field: 'archived' },
          },
        );
      }
      return s.chats.create(s.projects.primaryOf(projectId), { projectId });
    },
    'session:open': ({ sessionId }) => s.chats.open(sessionId),
    'session:set-model': ({ sessionId, model }) => s.chats.setModel(sessionId, model),
    'session:delete': async ({ sessionId }) => {
      await s.chats.delete(sessionId);
      return undefined;
    },

    // --- Utilisation (agrégats SQL du registre local, ADR-001)
    'usage:summary': ({ period }) => s.usage?.summary(period) ?? { period, models: [], daily: [] },

    // --- Prompts planifiés (ADR-002)
    ...(s.scheduler ? scheduleHandlers(s.scheduler, home, s.projects) : {}),

    // --- Projets et artefacts (ADR-003)
    ...(s.projects ? projectHandlers(s.projects) : {}),
    ...(s.projects ? sessionMoveHandlers(s.chats, s.projects) : {}),
    ...(s.voice ? voiceHandlers(s.voice) : {}),

    // --- Agent
    'agent:send': ({ sessionId, text, attachments, inputMode }) =>
      s.chats.send(sessionId, text, attachments, {
        // Requête venue du renderer : une valeur inconnue vaut « tapé ».
        ...(inputMode === 'dictation' || inputMode === 'voice' ? { inputMode } : {}),
      }),
    'agent:stop': async ({ sessionId }) => {
      await s.chats.stop(sessionId);
      return undefined;
    },
    'agent:retry': ({ sessionId }) => s.chats.retry(sessionId),
    // La voix n'autorise rien (ADR-004 §7) : seule la modale répond, par ce canal.
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
  projects: ProjectService | undefined,
): IpcHandlers {
  return {
    'schedule:list': () => scheduler.listTasks(),
    'schedule:save': async ({ id, task }) => {
      // Tâche de projet : son dossier est toujours le principal du projet (ADR-003 D6).
      if (task.projectId !== undefined && projects) {
        return scheduler.saveTask({ ...task, workspace: projects.primaryOf(task.projectId) }, id);
      }
      // Même règle de dossier qu'une conversation : ni la racine ni le $HOME entier.
      const { projectId: _ignored, ...single } = task;
      return scheduler.saveTask(
        { ...single, workspace: await assertWorkspace(task.workspace, home) },
        id,
      );
    },
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

function projectHandlers(projects: ProjectService): IpcHandlers {
  return {
    'project:list': ({ includeArchived }) => projects.list(includeArchived === true),
    'project:get': ({ id }) => projects.get(id),
    'project:create': ({ project }) => projects.create(project),
    'project:update': ({ id, patch }) => projects.update(id, patch),
    'project:set-archived': ({ id, archived }) => projects.setArchived(id, archived),
    'project:delete': async ({ id }) => {
      await projects.delete(id);
      return undefined;
    },
    'project:from-folder': ({ workspace, name }) => projects.fromFolder(workspace, name),
    'project:memory': ({ id }) => projects.memory(id),
    'project:memory-save': ({ id, content, baseRevision }) =>
      projects.saveMemory(id, content, baseRevision),
    'project:memory-history': ({ id, limit }) => projects.memoryHistory(id, limit),
    'artifact:list': ({ projectId }) => projects.listArtifacts(projectId),
    'artifact:get': ({ id }) => projects.getArtifact(id),
    'artifact:versions': ({ id }) => projects.artifactVersions(id),
    'artifact:delete': ({ id }) => {
      projects.deleteArtifact(id);
      return undefined;
    },
  };
}

/**
 * Déplacement d'une conversation par glisser-déposer (#21) : vers un projet,
 * d'un projet à l'autre, ou hors projet (`projectId: null`). Son dossier de
 * travail ne change jamais (`checkSessionMove`) ; le projet s'applique au tour
 * suivant. Refus : `session/move_refused` avec le motif, `agent/busy` pendant
 * un tour.
 */
function sessionMoveHandlers(
  chats: Pick<ChatManager, 'get' | 'setProject'>,
  projects: Pick<ProjectService, 'get' | 'notifyChanged'>,
): IpcHandlers {
  return {
    'session:set-project': ({ sessionId, projectId }) => {
      const session = chats.get(sessionId);
      const target = projectId === null ? undefined : projects.get(projectId);
      const refusal = checkSessionMove(session, target);
      if (refusal !== undefined) {
        throw new AtelierError('session/move_refused', refusal, {
          details: { sessionId, projectId },
        });
      }
      // Déjà à sa place : rien à changer ni à signaler.
      if ((session.projectId ?? null) === projectId) return session;
      const moved = chats.setProject(sessionId, projectId);
      // Compteurs et listes des deux projets (colonne de gauche, page du projet).
      for (const id of [session.projectId, projectId]) {
        if (id !== undefined && id !== null) projects.notifyChanged(id);
      }
      return moved;
    },
  };
}

/**
 * Canaux de la voix (ADR-004 §5). L'appelant (`context`) permet de refuser un
 * sous-cadre et une autre fenêtre que celle de la session.
 */
function voiceHandlers(voice: VoiceService): IpcHandlers {
  // Sans appelant connu, rien n'est accordé : ni micro, ni trames.
  const caller = (context: IpcCallContext | undefined): IpcCallContext =>
    context ?? { senderId: -1, fromMainFrame: false };
  return {
    'voice:status': () => voice.status(),
    'voice:request-mic': () => voice.requestMic(),
    'voice:open-mic-settings': async () => {
      await voice.openMicSettings();
      return undefined;
    },
    'voice:install-model': async ({ id }) => {
      await voice.installModel(id);
      return undefined;
    },
    'voice:cancel-install': ({ id }) => {
      voice.cancelInstall(id);
      return undefined;
    },
    'voice:remove-model': async ({ id }) => {
      await voice.removeModel(id);
      return undefined;
    },
    'voice:import-model': async ({ id }) => {
      await voice.importModel(id);
      return undefined;
    },
    'voice:start': (request, context) => {
      // Requête venue du renderer : validée avant usage.
      const mode = (request as { mode?: unknown } | undefined)?.mode;
      const sessionId = (request as { sessionId?: unknown } | undefined)?.sessionId;
      if (mode !== undefined && mode !== 'dictation' && mode !== 'conversation') {
        throw new AtelierError('tool/invalid_input', 'Mode vocal inconnu.');
      }
      return voice.start(caller(context), {
        ...(mode !== undefined ? { mode } : {}),
        ...(typeof sessionId === 'string' ? { sessionId } : {}),
      });
    },
    'voice:stop': ({ voiceSessionId }, context) => voice.stop(caller(context), voiceSessionId),
    'voice:cancel': ({ voiceSessionId }, context) => {
      voice.cancel(caller(context), voiceSessionId);
      return undefined;
    },
    'voice:audio': ({ voiceSessionId, seq, pcm }, context) => {
      voice.audio(caller(context), voiceSessionId, seq, pcm);
      return undefined;
    },
    'voice:interrupt': ({ voiceSessionId }, context) => {
      voice.interrupt(caller(context), voiceSessionId);
      return undefined;
    },
    'voice:playback-ended': ({ voiceSessionId, turnId, lastSeq }, context) => {
      voice.playbackEnded(caller(context), voiceSessionId, turnId, lastSeq);
      return undefined;
    },
  };
}
