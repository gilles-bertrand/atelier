/**
 * Shell de l'application après l'onboarding : colonne de gauche (navigation,
 * conversations, environnement) et vue principale (accueil, conversation ou
 * réglages), raccourcis ⌘B / ⌘N / ⌘K, modale de permission (y compris pour une
 * conversation en arrière-plan).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@atelier/shared';
import { HistoryBanner } from '@renderer/components/status/HistoryBanner';
import { Alert } from '@renderer/components/ui/primitives';
import { atelier, call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { ChatProvider, useChat } from '@renderer/state/chat-store';
import { ChatView } from './chat/ChatView';
import { PermissionDialog } from './chat/PermissionDialog';
import { Home } from './home/Home';
import { Settings } from './settings/Settings';
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
  const { actions } = useChat();
  const sidebar = useSidebarState();
  const [sessions, setSessions] = useState<SessionSummary[] | undefined>();
  const [current, setCurrent] = useState<SessionSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    setCurrent(session);
  }, []);

  const { showFolder } = sidebar;
  const newConversation = useCallback(
    async (workspace: string): Promise<void> => {
      setError(undefined);
      try {
        const session = await call('session:create', { workspace });
        setSessions((list) => upsert(list ?? [], session));
        showFolder(workspace);
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

  // ⌘N : dans le dossier de la conversation ouverte, sinon choix d'un dossier.
  const newFromShortcut = useCallback((): void => {
    if (current) void newConversation(current.workspace);
    else void chooseFolder();
  }, [current, newConversation, chooseFolder]);

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
              current={current}
              settingsActive={settingsOpen}
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
            ) : current ? (
              <ChatView
                key={current.id}
                session={current}
                onTitleChange={(title) => {
                  setSessions((list) =>
                    list?.map((s) => (s.id === current.id ? { ...s, title } : s)),
                  );
                }}
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
