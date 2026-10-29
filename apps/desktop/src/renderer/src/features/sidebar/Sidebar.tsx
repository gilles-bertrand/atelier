/**
 * Colonne de gauche : nouvelle conversation, recherche par titre, conversations
 * récentes, dossiers dépliables, puis en pied l'environnement et les réglages.
 */
import { useId, useMemo, useState, type RefObject } from 'react';
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Loader2,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
} from 'lucide-react';
import type { SessionSummary } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { fileName } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import { useApp } from '@renderer/state/app-state';
import { ActionMenu } from './ActionMenu';
import { ConversationList } from './ConversationList';
import { EnvironmentStatus } from './EnvironmentStatus';

/** Conversations affichées dans « Récentes ». */
export const RECENT_COUNT = 5;

/** Comparaison de titres insensible à la casse et aux accents. */
export function normalizeTitle(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('fr');
}

export interface FolderGroup {
  workspace: string;
  sessions: SessionSummary[];
}

/** Regroupe par dossier, le dossier le plus récemment actif en premier. */
export function groupByFolder(
  sessions: readonly SessionSummary[],
  hidden: readonly string[] = [],
): FolderGroup[] {
  const groups = new Map<string, SessionSummary[]>();
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const session of sorted) {
    if (hidden.includes(session.workspace)) continue;
    const list = groups.get(session.workspace);
    if (list) list.push(session);
    else groups.set(session.workspace, [session]);
  }
  return [...groups].map(([workspace, list]) => ({ workspace, sessions: list }));
}

function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

export function Sidebar({
  sessions,
  current,
  settingsActive,
  hiddenFolders,
  searchRef,
  onNewConversation,
  onNewIn,
  onChooseFolder,
  onOpen,
  onDelete,
  onHideFolder,
  onOpenSettings,
  onCollapse,
}: {
  /** `undefined` pendant le chargement. */
  sessions: readonly SessionSummary[] | undefined;
  current: SessionSummary | undefined;
  settingsActive: boolean;
  hiddenFolders: readonly string[];
  searchRef: RefObject<HTMLInputElement | null>;
  onNewConversation: () => void;
  onNewIn: (workspace: string) => void;
  onChooseFolder: () => void;
  onOpen: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => Promise<void>;
  onHideFolder: (workspace: string) => void;
  onOpenSettings: () => void;
  onCollapse: () => void;
}) {
  const { state } = useApp();
  const [query, setQuery] = useState('');
  // Dépliage choisi par l'utilisateur ; par défaut, seul le dossier courant est déplié.
  const [unfolded, setUnfolded] = useState<ReadonlyMap<string, boolean>>(new Map());
  const recentId = useId();
  const foldersId = useId();
  const resultsId = useId();
  const currentId = settingsActive ? undefined : current?.id;

  const folders = useMemo(
    () => groupByFolder(sessions ?? [], hiddenFolders),
    [sessions, hiddenFolders],
  );
  const results = useMemo(() => {
    const needle = normalizeTitle(query.trim());
    if (needle === '') return undefined;
    return (sessions ?? []).filter((s) => normalizeTitle(s.title).includes(needle));
  }, [sessions, query]);

  const isUnfolded = (workspace: string): boolean =>
    unfolded.get(workspace) ?? workspace === current?.workspace;

  const toggleFolder = (workspace: string): void => {
    setUnfolded((map) => new Map(map).set(workspace, !isUnfolded(workspace)));
  };

  return (
    <nav
      aria-label="Barre latérale"
      className="flex w-[260px] shrink-0 flex-col border-r bg-muted/30"
    >
      <div className="flex h-12 shrink-0 items-center justify-end pl-20 pr-2 [-webkit-app-region:drag]">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Masquer la barre latérale"
          title="Masquer la barre latérale (⌘B)"
          onClick={onCollapse}
          className="size-8 [-webkit-app-region:no-drag]"
        >
          <PanelLeftClose className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="space-y-2 px-3 pb-3">
        <Button
          variant="outline"
          className="w-full justify-start bg-background"
          onClick={onNewConversation}
          title="Nouvelle conversation (⌘N)"
        >
          <Plus className="size-4" aria-hidden />
          <span className="flex-1 text-left">Nouvelle conversation</span>
          <kbd className="text-xs font-normal text-muted-foreground" aria-hidden>
            ⌘N
          </kbd>
        </Button>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query !== '') {
                e.preventDefault();
                setQuery('');
              }
            }}
            aria-label="Rechercher une conversation"
            placeholder="Rechercher… (⌘K)"
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {sessions === undefined ? (
          <p className="flex items-center gap-2 px-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Chargement…
          </p>
        ) : results ? (
          <section aria-labelledby={resultsId} className="space-y-1.5">
            <SectionTitle id={resultsId}>Résultats</SectionTitle>
            {results.length > 0 ? (
              <ConversationList
                label="Résultats de la recherche"
                sessions={results}
                currentId={currentId}
                onOpen={onOpen}
                onDelete={onDelete}
                showFolder
              />
            ) : (
              <p className="px-2 text-sm text-muted-foreground" role="status">
                Aucune conversation ne correspond.
              </p>
            )}
          </section>
        ) : (
          <>
            <section aria-labelledby={recentId} className="space-y-1.5">
              <SectionTitle id={recentId}>Récentes</SectionTitle>
              {sessions.length > 0 ? (
                <ConversationList
                  label="Conversations récentes"
                  sessions={sessions.slice(0, RECENT_COUNT)}
                  currentId={currentId}
                  onOpen={onOpen}
                  onDelete={onDelete}
                  showFolder
                />
              ) : (
                <p className="px-2 text-sm text-muted-foreground">
                  Aucune conversation pour l’instant.
                </p>
              )}
            </section>

            <section aria-labelledby={foldersId} className="space-y-1.5">
              <div className="flex items-center justify-between pr-1">
                <SectionTitle id={foldersId}>Dossiers</SectionTitle>
                <button
                  type="button"
                  aria-label="Ouvrir un dossier"
                  title="Ouvrir un dossier"
                  onClick={onChooseFolder}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FolderPlus className="size-4" aria-hidden />
                </button>
              </div>
              {folders.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">
                  Les dossiers de vos conversations apparaîtront ici.
                </p>
              ) : (
                <ul aria-label="Dossiers" className="space-y-0.5">
                  {folders.map((folder) => {
                    const name = fileName(folder.workspace);
                    const open = isUnfolded(folder.workspace);
                    return (
                      <li key={folder.workspace}>
                        <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-accent/60">
                          <button
                            type="button"
                            aria-expanded={open}
                            title={folder.workspace}
                            onClick={() => {
                              toggleFolder(folder.workspace);
                            }}
                            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ChevronRight
                              className={cn(
                                'size-3.5 shrink-0 text-muted-foreground transition-transform',
                                open ? 'rotate-90' : undefined,
                              )}
                              aria-hidden
                            />
                            <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate">{name}</span>
                          </button>
                          <ActionMenu
                            label={`Actions pour le dossier « ${name} »`}
                            className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100"
                            items={[
                              {
                                label: 'Nouvelle conversation ici',
                                onSelect: () => {
                                  onNewIn(folder.workspace);
                                },
                              },
                              {
                                label: 'Retirer de la liste',
                                onSelect: () => {
                                  onHideFolder(folder.workspace);
                                },
                              },
                            ]}
                          />
                        </div>
                        {open ? (
                          <div className="ml-4 border-l pl-1.5">
                            <ConversationList
                              label={`Conversations du dossier ${name}`}
                              sessions={folder.sessions}
                              currentId={currentId}
                              onOpen={onOpen}
                              onDelete={onDelete}
                            />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      <div className="shrink-0">
        <EnvironmentStatus
          session={current}
          sandbox={state.sandbox}
          server={state.server}
          model={state.settings.llm.model}
        />
        <div className="border-t p-2">
          <button
            type="button"
            aria-current={settingsActive ? 'page' : undefined}
            onClick={onOpenSettings}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              settingsActive ? 'bg-accent font-medium' : 'hover:bg-accent/60',
            )}
          >
            <Settings className="size-4 text-muted-foreground" aria-hidden />
            Réglages
          </button>
        </div>
      </div>
    </nav>
  );
}
