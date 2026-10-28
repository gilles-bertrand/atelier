/**
 * Application après l'onboarding : accueil ⇄ conversation, et modale de
 * permission (y compris pour une conversation en arrière-plan).
 */
import { useState } from 'react';
import type { SessionSummary } from '@atelier/shared';
import { HistoryBanner } from '@renderer/components/status/HistoryBanner';
import { Alert } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { ChatProvider, useChat } from '@renderer/state/chat-store';
import { ChatView } from './chat/ChatView';
import { PermissionDialog } from './chat/PermissionDialog';
import { Home } from './home/Home';
import { Settings } from './settings/Settings';

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

function WorkspaceViews() {
  const { actions } = useChat();
  const [current, setCurrent] = useState<SessionSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = (): void => {
    setSettingsOpen(true);
  };

  const newConversation = async (workspace: string): Promise<void> => {
    try {
      setCurrent(await call('session:create', { workspace }));
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <HistoryBanner />
      <div className="min-h-0 flex-1">
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
            onBack={() => {
              setCurrent(undefined);
            }}
            onNewConversation={() => void newConversation(current.workspace)}
            onOpenSettings={openSettings}
          />
        ) : (
          <Home
            onOpen={setCurrent}
            onOpenSettings={openSettings}
            onDeleted={(sessionId) => {
              actions.forget(sessionId);
            }}
          />
        )}
      </div>
      {error ? (
        <div className="fixed bottom-4 left-1/2 w-full max-w-md -translate-x-1/2">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}
      <PendingPermission current={current} />
    </div>
  );
}

export function Workspace() {
  return (
    <ChatProvider>
      <WorkspaceViews />
    </ChatProvider>
  );
}
