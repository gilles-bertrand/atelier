/**
 * Shell de l'application après l'onboarding : colonne de gauche (navigation,
 * conversations, environnement) et vue principale (accueil, conversation ou
 * réglages), raccourcis ⌘B / ⌘N / ⌘K, modale de permission (y compris pour une
 * conversation en arrière-plan).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeniedAction, Project, ProjectSummary, SessionSummary } from '@atelier/shared';
import { HistoryBanner } from '@renderer/components/status/HistoryBanner';
import { Alert } from '@renderer/components/ui/primitives';
import { atelier, call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { ChatProvider, useChat } from '@renderer/state/chat-store';
import { ChatView } from './chat/ChatView';
import { PermissionDialog } from './chat/PermissionDialog';
import { Home } from './home/Home';
import { NewProjectDialog } from './projects/NewProjectDialog';
import { ProjectView } from './projects/ProjectView';
import { ScheduleView, type FormRequest } from './schedule/ScheduleView';
import { Settings } from './settings/Settings';
import { sessionActivity } from './sidebar/activity';
import { ShellChromeProvider, type ShellChrome } from './sidebar/shell-chrome';
import { Sidebar } from './sidebar/Sidebar';
import { useSidebarState } from './sidebar/useSidebarState';

/** Conversations chargées pour la colonne (Récentes, dossiers, recherche). */
export const SESSION_LIST_LIMIT = 200;

function PendingPermission({ current }: { current: SessionSummary | undefined }) {
  const { state, actions } = useChat();
  const [error, setError] = useState<string | undefined>();
  // Priorité à la conversation affichée, sinon la première qui attend.
  const entry =
    (current && state[current.id]?.permissions[0]) ??
    Object.values(state).find((s) => s.permissions.length > 0)?.permissions[0];
  if (!entry) return error ? <Alert tone="error">{error}</Alert> : null;
  return (
    <PermissionDialog
      request={entry}
      {...(current?.id !== entry.sessionId ? { sessionTitle: 'autre conversation' } : {})}
      onDecide={(decision) => {
        actions.respond(entry, decision).catch((e: unknown) => {
          setError(errorMessage(toSerializedError(e)));
        });
      }}
    />
  );
}

/** Ajoute ou remplace une conversation, la plus récente en tête. */
function upsert(list: readonly SessionSummary[], session: SessionSummary): SessionSummary[] {
  return [session, ...list.filter((s) => s.id !== session.id)];
}

function WorkspaceViews() {
  const { state: chat, actions } = useChat();
  // Pastilles de la colonne : l'assistant travaille, ou attend un accord.
  const activity = useMemo(() => sessionActivity(chat), [chat]);
  const sidebar = useSidebarState();
  const [sessions, setSessions] = useState<SessionSummary[] | undefined>();
  const [current, setCurrent] = useState<SessionSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Tâches planifiées (ADR-002 D7) : tableau de bord, ou formulaire demandé par un run.
  const [schedule, setSchedule] = useState<{ request?: FormRequest } | undefined>();
  // Projets (ADR-003) : liste de la colonne, page affichée, modale de création.
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>();
  const [projectPage, setProjectPage] = useState<string | undefined>();
  const [creatingProject, setCreatingProject] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // ⌘K avec la colonne masquée : le champ n'existe qu'après son affichage.
  const pendingSearchFocus = useRef(false);

  const refresh = useCallback(
    (): Promise<void> =>
      call('session:list', { limit: SESSION_LIST_LIMIT }).then(
        (list) => {
          setSessions(list);
        },
        (e: unknown) => {
          setSessions((list) => list ?? []);
          setError(errorMessage(toSerializedError(e)));
        },
      ),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshProjects = useCallback(
    (): Promise<void> =>
      call('project:list', {}).then(
        (list) => {
          setProjects(list);
        },
        () => {
          setProjects((list) => list ?? []);
        },
      ),
    [],
  );

  useEffect(() => {
    void refreshProjects();
    return atelier().on('project:changed', () => {
      void refreshProjects();
      void refresh();
    });
  }, [refreshProjects, refresh]);

  // Fin d'un tour : titre et date d'activité ont pu changer côté main.
  useEffect(
    () =>
      atelier().on('agent:event', (event) => {
        if (event.type === 'done' || event.type === 'error') void refresh();
      }),
    [refresh],
  );

  const open = useCallback((session: SessionSummary): void => {
    setSettingsOpen(false);
    setSchedule(undefined);
    setProjectPage(undefined);
    setCurrent(session);
  }, []);

  const openProject = useCallback((projectId: string): void => {
    setSettingsOpen(false);
    setSchedule(undefined);
    setProjectPage(projectId);
  }, []);

  /** Conversation d'un run (absente des « Récentes ») ouverte depuis le tableau de bord. */
  const openSessionById = useCallback(
    (sessionId: string): void => {
      call('session:open', { sessionId }).then(
        ({ session }) => {
          open(session);
        },
        (e: unknown) => {
          setError(errorMessage(toSerializedError(e)));
        },
      );
    },
    [open],
  );

  // Clic sur la notification de fin d'un run (ADR-002 D7) : sa conversation s'ouvre.
  useEffect(
    () =>
      atelier().on('app:open-session', ({ sessionId }) => {
        openSessionById(sessionId);
      }),
    [openSessionById],
  );

  /** « Autoriser pour cette tâche » : formulaire de la tâche, cases des refus pré-cochées. */
  const authorizeTask = useCallback((taskId: string, denied: DeniedAction[]): void => {
    call('schedule:list').then(
      (tasks) => {
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          setError('Cette tâche planifiée n’existe plus.');
          return;
        }
        setSettingsOpen(false);
        setProjectPage(undefined);
        setSchedule({ request: { task, denied } });
      },
      (e: unknown) => {
        setError(errorMessage(toSerializedError(e)));
      },
    );
  }, []);

  const { showFolder } = sidebar;
  const newConversation = useCallback(
    async (workspace: string, projectId?: string): Promise<void> => {
      setError(undefined);
      try {
        const session = await call('session:create', {
          workspace,
          ...(projectId !== undefined ? { projectId } : {}),
        });
        setSessions((list) => upsert(list ?? [], session));
        if (projectId === undefined) showFolder(workspace);
        open(session);
      } catch (e) {
        setError(errorMessage(toSerializedError(e)));
      }
    },
    [open, showFolder],
  );

  const chooseFolder = useCallback(async (): Promise<void> => {
    setError(undefined);
    try {
      const workspace = await call('workspace:choose');
      if (workspace !== null) await newConversation(workspace);
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    }
  }, [newConversation]);

  /** Nouvelle conversation dans un projet, dans son dossier principal. */
  const newInProject = useCallback(
    (project: Pick<Project, 'id' | 'folders'>): void => {
      const primary = project.folders[0]?.path;
      if (primary !== undefined) void newConversation(primary, project.id);
    },
    [newConversation],
  );

  // ⌘N : dans le projet affiché ou celui de la conversation ouverte, sinon dans
  // son dossier, sinon choix d'un dossier.
  const newFromShortcut = useCallback((): void => {
    const pageProject = projects?.find((p) => p.id === projectPage);
    if (pageProject) newInProject(pageProject);
    else if (current?.projectId !== undefined) {
      void newConversation(current.workspace, current.projectId);
    } else if (current) void newConversation(current.workspace);
    else void chooseFolder();
  }, [current, newConversation, newInProject, chooseFolder, projects, projectPage]);

  /** « Créer un projet à partir de ce dossier » : ses conversations rejoignent le projet. */
  const projectFromFolder = useCallback(
    async (workspace: string): Promise<void> => {
      setError(undefined);
      try {
        const project = await call('project:from-folder', { workspace });
        await Promise.all([refresh(), refreshProjects()]);
        openProject(project.id);
      } catch (e) {
        setError(errorMessage(toSerializedError(e)));
      }
    },
    [refresh, refreshProjects, openProject],
  );

  const projectAction = (task: () => Promise<unknown>): void => {
    setError(undefined);
    task().catch((e: unknown) => {
      setError(errorMessage(toSerializedError(e)));
    });
  };
  const currentProject =
    current?.projectId !== undefined
      ? projects?.find((p) => p.id === current.projectId)
      : undefined;

  const remove = async (session: SessionSummary): Promise<void> => {
    setError(undefined);
    try {
      await call('session:delete', { sessionId: session.id });
      setSessions((list) => list?.filter((s) => s.id !== session.id));
      actions.forget(session.id);
      if (current?.id === session.id) setCurrent(undefined);
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    }
  };

  const { open: sidebarOpen, toggle: toggleSidebar } = sidebar;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      // Une demande de permission attend une réponse : pas de navigation par-dessus.
      if (document.querySelector('[role="alertdialog"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'b') {
        event.preventDefault();
        toggleSidebar();
      } else if (key === 'n') {
        event.preventDefault();
        newFromShortcut();
      } else if (key === 'k') {
        event.preventDefault();
        if (sidebarOpen) {
          searchRef.current?.focus();
          searchRef.current?.select();
        } else {
          pendingSearchFocus.current = true;
          toggleSidebar();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [sidebarOpen, toggleSidebar, newFromShortcut]);

  useEffect(() => {
    if (!sidebarOpen || !pendingSearchFocus.current) return;
    pendingSearchFocus.current = false;
    searchRef.current?.focus();
  }, [sidebarOpen]);

  const chrome = useMemo<ShellChrome>(
    () => ({ sidebarOpen, toggleSidebar }),
    [sidebarOpen, toggleSidebar],
  );

  return (
    <ShellChromeProvider value={chrome}>
      <div className="flex h-full flex-col">
        <HistoryBanner />
        <div className="flex min-h-0 flex-1">
          {sidebarOpen ? (
            <Sidebar
              sessions={sessions}
              activity={activity}
              current={current}
              settingsActive={settingsOpen}
              scheduleActive={schedule !== undefined && !settingsOpen}
              projects={projects}
              projectActiveId={settingsOpen || schedule !== undefined ? undefined : projectPage}
              onOpenProject={(project) => {
                openProject(project.id);
              }}
              onNewProject={() => {
                setCreatingProject(true);
              }}
              onNewInProject={newInProject}
              onArchiveProject={(project) => {
                projectAction(async () => {
                  await call('project:set-archived', { id: project.id, archived: true });
                  await refreshProjects();
                });
              }}
              onRevealProject={(project) => {
                const primary = project.folders[0]?.path;
                if (primary !== undefined) {
                  projectAction(() => call('file:reveal', { absolutePath: primary }));
                }
              }}
              onProjectFromFolder={(workspace) => void projectFromFolder(workspace)}
              hiddenFolders={sidebar.hiddenFolders}
              searchRef={searchRef}
              onNewConversation={newFromShortcut}
              onNewIn={(workspace) => void newConversation(workspace)}
              onChooseFolder={() => void chooseFolder()}
              onOpen={open}
              onDelete={remove}
              onHideFolder={sidebar.hideFolder}
              onOpenSettings={() => {
                setSettingsOpen(true);
              }}
              onOpenSchedule={() => {
                setSettingsOpen(false);
                setProjectPage(undefined);
                setSchedule({});
              }}
              onCollapse={toggleSidebar}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            {settingsOpen ? (
              <Settings
                onClose={() => {
                  setSettingsOpen(false);
                }}
              />
            ) : schedule ? (
              <ScheduleView
                // Nouvelle demande (« Autoriser… ») : le formulaire repart de zéro.
                key={
                  schedule.request
                    ? `form-${schedule.request.task?.id ?? `new-${schedule.request.projectId ?? ''}`}`
                    : 'dashboard'
                }
                onOpenSession={openSessionById}
                {...(schedule.request ? { request: schedule.request } : {})}
              />
            ) : projectPage !== undefined ? (
              <ProjectView
                key={projectPage}
                projectId={projectPage}
                onOpenSession={open}
                onNewConversation={newInProject}
                onNewTask={(project) => {
                  setProjectPage(undefined);
                  setSchedule({ request: { projectId: project.id } });
                }}
                onOpenTask={(task) => {
                  setProjectPage(undefined);
                  setSchedule({ request: { task } });
                }}
                onDeleted={() => {
                  setProjectPage(undefined);
                  if (current?.projectId === projectPage) setCurrent(undefined);
                  void refresh();
                  void refreshProjects();
                }}
              />
            ) : current ? (
              <ChatView
                key={current.id}
                session={current}
                onTitleChange={(title) => {
                  setSessions((list) =>
                    list?.map((s) => (s.id === current.id ? { ...s, title } : s)),
                  );
                }}
                onSessionChange={(updated) => {
                  setCurrent(updated);
                  setSessions((list) => list?.map((s) => (s.id === updated.id ? updated : s)));
                }}
                onAuthorizeTask={authorizeTask}
                {...(currentProject
                  ? {
                      project: currentProject,
                      onOpenProject: () => {
                        openProject(currentProject.id);
                      },
                    }
                  : {})}
              />
            ) : (
              <Home onChooseFolder={chooseFolder} />
            )}
          </div>
        </div>
        {error ? (
          <div className="fixed bottom-4 left-1/2 w-full max-w-md -translate-x-1/2">
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
        <PendingPermission current={current} />
        {creatingProject ? (
          <NewProjectDialog
            onCancel={() => {
              setCreatingProject(false);
            }}
            onCreated={(project) => {
              setCreatingProject(false);
              void refreshProjects();
              openProject(project.id);
            }}
          />
        ) : null}
      </div>
    </ShellChromeProvider>
  );
}

export function Workspace() {
  return (
    <ChatProvider>
      <WorkspaceViews />
    </ChatProvider>
  );
}
