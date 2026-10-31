/**
 * Page d'un projet (ADR-003 D7) : en-tête (nom, description, nouvelle
 * conversation, dossier, archivage, suppression) et cinq onglets :
 * conversations, artefacts, tâches planifiées, mémoire et consignes, dossiers.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  CalendarClock,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  defaultFolderLabel,
  describeSchedule,
  MEMORY_PROMPT_CHARS,
  type Artifact,
  type MemoryRevision,
  type Project,
  type ProjectFolder,
  type ProjectMemory,
  type ScheduledTask,
  type SessionSummary,
} from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Input, Select } from '@renderer/components/ui/primitives';
import { atelier, call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { cn } from '@renderer/lib/utils';
import { Markdown } from '../chat/Markdown';
import { headerInset, SidebarOpenButton, useShellChrome } from '../sidebar/shell-chrome';
import { ArtifactViewer, versionLabel } from './ArtifactViewer';

export type ProjectTab = 'conversations' | 'artifacts' | 'tasks' | 'memory' | 'folders';

const TABS: readonly { id: ProjectTab; label: string }[] = [
  { id: 'conversations', label: 'Conversations' },
  { id: 'artifacts', label: 'Artefacts' },
  { id: 'tasks', label: 'Tâches' },
  { id: 'memory', label: 'Mémoire et consignes' },
  { id: 'folders', label: 'Dossiers' },
];

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Erreur IPC traduite (affichage). */
function messageOf(e: unknown): string {
  return errorMessage(toSerializedError(e));
}

export function ProjectView({
  projectId,
  initialTab = 'conversations',
  onOpenSession,
  onNewConversation,
  onNewTask,
  onOpenTask,
  onDeleted,
}: {
  projectId: string;
  initialTab?: ProjectTab;
  onOpenSession: (session: SessionSummary) => void;
  onNewConversation: (project: Project) => void;
  onNewTask: (project: Project) => void;
  onOpenTask: (task: ScheduledTask) => void;
  onDeleted: () => void;
}) {
  const { sidebarOpen } = useShellChrome();
  const tabsId = useId();
  const [project, setProject] = useState<Project | undefined>();
  const [tab, setTab] = useState<ProjectTab>(initialTab);
  const [error, setError] = useState<string | undefined>();
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(
    (): Promise<void> =>
      call('project:get', { id: projectId }).then(setProject, (e: unknown) => {
        setError(messageOf(e));
      }),
    [projectId],
  );

  useEffect(() => {
    void load();
    return atelier().on('project:changed', ({ projectId: changed }) => {
      if (changed === projectId) void load();
    });
  }, [projectId, load]);

  const run = (task: () => Promise<unknown>): void => {
    setError(undefined);
    task().catch((e: unknown) => {
      setError(messageOf(e));
    });
  };

  if (!project) {
    return <div className="p-6">{error ? <Alert tone="error">{error}</Alert> : 'Chargement…'}</div>;
  }
  const primary = project.folders[0];
  const archived = project.archivedAt !== undefined;

  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 border-b pr-4 [-webkit-app-region:drag]',
          headerInset(sidebarOpen),
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
          <SidebarOpenButton />
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = new FormData(e.currentTarget).get('name');
                run(async () => {
                  setProject(
                    await call('project:update', {
                      id: project.id,
                      patch: { name: typeof name === 'string' ? name : project.name },
                    }),
                  );
                  setRenaming(false);
                });
              }}
            >
              <Input
                name="name"
                aria-label="Nom du projet"
                defaultValue={project.name}
                autoFocus
                onBlur={() => {
                  setRenaming(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(false);
                }}
                className="h-8"
              />
            </form>
          ) : (
            <h1 className="flex min-w-0 items-center gap-1 truncate text-sm font-medium">
              <span className="truncate">{project.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Renommer le projet"
                onClick={() => {
                  setRenaming(true);
                }}
              >
                <Pencil className="size-3.5" aria-hidden />
              </Button>
            </h1>
          )}
          {archived ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              Archivé
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <Button
            size="sm"
            disabled={archived}
            aria-label="Nouvelle conversation dans le projet"
            onClick={() => {
              onNewConversation(project);
            }}
          >
            <MessageSquarePlus className="size-4" aria-hidden />
            Nouvelle conversation
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Afficher le dossier du projet dans le Finder"
            title="Afficher le dossier du projet dans le Finder"
            disabled={!primary}
            onClick={() => {
              if (primary) run(() => call('file:reveal', { absolutePath: primary.path }));
            }}
          >
            <FolderOpen className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={archived ? 'Désarchiver le projet' : 'Archiver le projet'}
            title={archived ? 'Désarchiver' : 'Archiver (masque le projet, suspend ses tâches)'}
            onClick={() => {
              run(async () => {
                setProject(
                  await call('project:set-archived', { id: project.id, archived: !archived }),
                );
              });
            }}
          >
            {archived ? (
              <ArchiveRestore className="size-4" aria-hidden />
            ) : (
              <Archive className="size-4" aria-hidden />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Supprimer le projet"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-6">
          {project.description ? (
            <p className="text-sm text-muted-foreground">{project.description}</p>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          {confirmDelete ? (
            <Alert tone="warning" title="Supprimer ce projet ?">
              Le projet, ses conversations, ses tâches, sa mémoire et l’historique de ses artefacts
              seront retirés d’Atelier. Aucun fichier n’est supprimé de votre disque.
              <span className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    run(async () => {
                      await call('project:delete', { id: project.id });
                      onDeleted();
                    });
                  }}
                >
                  Supprimer
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmDelete(false);
                  }}
                >
                  Annuler
                </Button>
              </span>
            </Alert>
          ) : null}

          <div role="tablist" aria-label="Sections du projet" className="flex gap-1 border-b">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${tabsId}-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${tabsId}-panel`}
                onClick={() => {
                  setTab(t.id);
                }}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tab === t.id
                    ? 'border-brand font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
            {tab === 'conversations' ? (
              <ConversationsTab project={project} onOpen={onOpenSession} />
            ) : tab === 'artifacts' ? (
              <ArtifactsTab project={project} />
            ) : tab === 'tasks' ? (
              <TasksTab project={project} onNew={onNewTask} onOpen={onOpenTask} />
            ) : tab === 'memory' ? (
              <MemoryTab project={project} onSaved={setProject} />
            ) : (
              <FoldersTab project={project} onSaved={setProject} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function ConversationsTab({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: (session: SessionSummary) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(() => {
    call('session:list', { limit: 200, projectId: project.id }).then(setSessions, (e: unknown) => {
      setError(messageOf(e));
    });
  }, [project.id]);
  useEffect(() => {
    load();
    return atelier().on('agent:event', (event) => {
      if (event.type === 'done' || event.type === 'error') load();
    });
  }, [load]);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!sessions) return null;
  if (sessions.length === 0)
    return <Empty>Aucune conversation dans ce projet pour l’instant.</Empty>;
  return (
    <ul className="divide-y rounded-lg border" aria-label="Conversations du projet">
      {sessions.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => {
              onOpen(s);
            }}
            className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{s.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{dateLabel(s.updatedAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ArtifactsTab({ project }: { project: Project }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(() => {
    call('artifact:list', { projectId: project.id }).then(setArtifacts, (e: unknown) => {
      setError(messageOf(e));
    });
  }, [project.id]);
  useEffect(() => {
    load();
    return atelier().on('artifact:changed', ({ artifact }) => {
      if (artifact.projectId === project.id) load();
    });
  }, [load, project.id]);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (open) {
    return (
      <div className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(undefined);
          }}
        >
          ← Tous les artefacts
        </Button>
        <ArtifactViewer id={open} className="h-[70vh] rounded-lg border" />
      </div>
    );
  }
  if (!artifacts) return null;
  if (artifacts.length === 0) {
    return (
      <Empty>
        Aucun artefact pour l’instant. Demandez par exemple « Fais-moi un tableau de bord des ventes
        » : l’assistant publie la page ici, et une tâche planifiée peut la mettre à jour.
      </Empty>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-label="Artefacts du projet">
      {artifacts.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => {
              setOpen(a.id);
            }}
            aria-label={`Ouvrir l’artefact « ${a.title} »`}
            className="flex h-full w-full flex-col gap-1 rounded-lg border bg-card p-4 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex items-center gap-2 font-medium">
              <AppWindow className="size-4 text-brand-text" aria-hidden />
              {a.title}
            </span>
            {a.description ? (
              <span className="text-sm text-muted-foreground">{a.description}</span>
            ) : null}
            <span className="mt-auto text-xs text-muted-foreground">
              {versionLabel({
                version: a.version,
                createdAt: a.updatedAt,
                ...(a.taskName ? { taskName: a.taskName } : {}),
              })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TasksTab({
  project,
  onNew,
  onOpen,
}: {
  project: Project;
  onNew: (project: Project) => void;
  onOpen: (task: ScheduledTask) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(() => {
    call('schedule:list').then(
      (list) => {
        setTasks(list.filter((t) => t.projectId === project.id));
      },
      (e: unknown) => {
        setError(messageOf(e));
      },
    );
  }, [project.id]);
  useEffect(() => {
    load();
    return atelier().on('schedule:changed', load);
  }, [load]);
  if (error) return <Alert tone="error">{error}</Alert>;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={project.archivedAt !== undefined}
          onClick={() => {
            onNew(project);
          }}
        >
          <CalendarClock className="size-4" aria-hidden />
          Nouvelle tâche
        </Button>
      </div>
      {tasks && tasks.length === 0 ? (
        <Empty>
          Aucune tâche planifiée. Une tâche du projet travaille dans ses dossiers, suit ses
          consignes et peut mettre à jour sa mémoire et ses artefacts.
        </Empty>
      ) : null}
      {tasks && tasks.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="Tâches du projet">
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  onOpen(t);
                }}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{t.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {describeSchedule(t.schedule)}
                    {t.enabled ? '' : ' · désactivée'}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t.nextRunAt ? `Prochaine : ${dateLabel(t.nextRunAt)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MemoryTab({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  const instructionsId = useId();
  const memoryId = useId();
  const [instructions, setInstructions] = useState(project.instructions);
  const [memory, setMemory] = useState<ProjectMemory | undefined>();
  const [draft, setDraft] = useState<string | undefined>();
  const [history, setHistory] = useState<MemoryRevision[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const load = useCallback(() => {
    call('project:memory', { id: project.id }).then(setMemory, (e: unknown) => {
      setError(messageOf(e));
    });
  }, [project.id]);
  useEffect(() => {
    load();
    return atelier().on('project:changed', ({ projectId }) => {
      if (projectId === project.id) load();
    });
  }, [load, project.id]);

  const saveMemory = async (content: string): Promise<void> => {
    if (!memory) return;
    setError(undefined);
    try {
      setMemory(
        await call('project:memory-save', {
          id: project.id,
          content,
          baseRevision: memory.revision,
        }),
      );
      setDraft(undefined);
      setHistory(undefined);
      setNotice('Mémoire enregistrée.');
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const length = (draft ?? memory?.content ?? '').length;
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          <label htmlFor={instructionsId}>Consignes du projet</label>
        </h2>
        <Hint>
          Suivies dans chaque conversation et chaque tâche du projet (ex. « Réponds en tableau », «
          Le client s’appelle… »).
        </Hint>
        <textarea
          id={instructionsId}
          rows={4}
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
          }}
          className="block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={instructions === project.instructions}
          onClick={() => {
            setError(undefined);
            call('project:update', { id: project.id, patch: { instructions } }).then(
              (saved) => {
                onSaved(saved);
                setNotice('Consignes enregistrées.');
              },
              (e: unknown) => {
                setError(messageOf(e));
              },
            );
          }}
        >
          Enregistrer les consignes
        </Button>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            <label htmlFor={memoryId}>Mémoire du projet</label>
          </h2>
          <span
            className={cn(
              'text-xs',
              length > MEMORY_PROMPT_CHARS ? 'text-warning-text' : 'text-muted-foreground',
            )}
          >
            {length.toLocaleString('fr-FR')} / {MEMORY_PROMPT_CHARS.toLocaleString('fr-FR')}{' '}
            caractères relus par l’assistant
          </span>
        </div>
        <Hint>
          Ce que l’assistant a retenu au fil des conversations (avec votre accord) et ce que vous y
          ajoutez. Il la relit au début de chaque conversation, comme des notes et non comme des
          ordres.
        </Hint>
        {draft !== undefined ? (
          <>
            <textarea
              id={memoryId}
              rows={10}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              className="block w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void saveMemory(draft)}>
                Enregistrer la mémoire
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(undefined);
                }}
              >
                Annuler
              </Button>
            </div>
          </>
        ) : (
          <>
            <div id={memoryId} className="rounded-lg border bg-card p-4 text-sm">
              {memory && memory.content.trim() !== '' ? (
                <Markdown text={memory.content} />
              ) : (
                <span className="text-muted-foreground">La mémoire est vide.</span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!memory}
                onClick={() => {
                  setNotice(undefined);
                  setDraft(memory?.content ?? '');
                }}
              >
                Modifier
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  call('project:memory-history', { id: project.id, limit: 30 }).then(
                    setHistory,
                    (e: unknown) => {
                      setError(messageOf(e));
                    },
                  );
                }}
              >
                Historique
              </Button>
            </div>
          </>
        )}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {error ? (
          <Alert tone="error">
            {error}
            <Button
              size="sm"
              variant="ghost"
              className="ml-2"
              onClick={() => {
                setError(undefined);
                load();
              }}
            >
              Recharger
            </Button>
          </Alert>
        ) : null}
        {history ? (
          <ul className="divide-y rounded-lg border text-sm" aria-label="Historique de la mémoire">
            {history.map((r) => (
              <li key={r.revision} className="flex items-center justify-between gap-2 px-4 py-2">
                <span>
                  Révision {r.revision} · {dateLabel(r.createdAt)} ·{' '}
                  {r.source === 'agent' ? 'assistant' : 'vous'}
                </span>
                {r.revision !== memory?.revision ? (
                  <Button size="sm" variant="ghost" onClick={() => void saveMemory(r.content)}>
                    Revenir à cette version
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">actuelle</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function FoldersTab({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  // Brouillon rattaché à la liste enregistrée : un projet mis à jour (enregistrement,
  // autre fenêtre) le périme, sans effet qui recopie l'état.
  const [draft, setDraft] = useState<
    { base: readonly ProjectFolder[]; folders: ProjectFolder[] } | undefined
  >();
  const folders = draft?.base === project.folders ? draft.folders : project.folders;
  const setFolders = (update: (list: ProjectFolder[]) => ProjectFolder[]): void => {
    setDraft({ base: project.folders, folders: update(folders) });
  };
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const changed = JSON.stringify(folders) !== JSON.stringify(project.folders);

  const update = (index: number, patch: Partial<ProjectFolder>): void => {
    setFolders((list) => list.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  return (
    <div className="space-y-3">
      <Hint>
        L’assistant lit et écrit dans le dossier principal (les livrables y vont par défaut), et
        dans les autres dossiers selon leur accès. Il les désigne par leur nom court (« Compta/… »).
      </Hint>
      <ul className="divide-y rounded-lg border" aria-label="Dossiers du projet">
        {folders.map((folder, index) => (
          <li key={folder.path} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
            <Input
              aria-label={`Nom court du dossier ${folder.path}`}
              value={folder.label}
              onChange={(e) => {
                update(index, { label: e.target.value });
              }}
              className="h-8 w-40"
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={folder.path}>
              {folder.path}
            </span>
            {index === 0 ? (
              <span className="rounded bg-brand-soft px-1.5 py-0.5 text-xs text-brand-text">
                Principal
              </span>
            ) : (
              <>
                <Select
                  aria-label={`Accès au dossier ${folder.label}`}
                  value={folder.access}
                  onChange={(e) => {
                    update(index, { access: e.target.value === 'read' ? 'read' : 'write' });
                  }}
                  className="h-8 w-44 text-xs"
                >
                  <option value="write">Lecture et écriture</option>
                  <option value="read">Lecture seule</option>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFolders((list) => [
                      { ...folder, access: 'write' },
                      ...list.filter((_, i) => i !== index),
                    ]);
                  }}
                >
                  Définir comme principal
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Retirer le dossier ${folder.label}`}
                  onClick={() => {
                    setFolders((list) => list.filter((_, i) => i !== index));
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void call('dialog:choose-directory', { title: 'Dossier à rattacher au projet' }).then(
              (dir) => {
                if (dir === null || folders.some((f) => f.path === dir)) return;
                setFolders((list) => [
                  ...list,
                  { path: dir, label: defaultFolderLabel(dir), access: 'write' },
                ]);
              },
            );
          }}
        >
          <FolderPlus className="size-4" aria-hidden />
          Ajouter un dossier
        </Button>
        <Button
          size="sm"
          disabled={!changed}
          onClick={() => {
            setError(undefined);
            call('project:update', { id: project.id, patch: { folders } }).then(
              (saved) => {
                onSaved(saved);
                setNotice('Dossiers enregistrés : ils servent dès le prochain message.');
              },
              (e: unknown) => {
                setError(messageOf(e));
              },
            );
          }}
        >
          Enregistrer les dossiers
        </Button>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
