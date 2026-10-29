/**
 * Écran de conversation : en-tête (titre, dossier, état du serveur, panneau de
 * suivi), fil des messages, saisie, et dépôt de fichiers sur toute la zone.
 */
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { Folder, PanelRight, Upload } from 'lucide-react';
import type { SessionSummary } from '@atelier/shared';
import { ServerStatusBadge } from '@renderer/components/status/ServerStatusBadge';
import { Button } from '@renderer/components/ui/button';
import { Alert } from '@renderer/components/ui/primitives';
import { atelier, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { fileName } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import { useApp } from '@renderer/state/app-state';
import { isRunning } from '@renderer/state/chat-reducer';
import { useChat, useSessionView } from '@renderer/state/chat-store';
import { deriveSessionTitle } from '../../../../common/chat-reducer';
import { headerInset, SidebarOpenButton, useShellChrome } from '../sidebar/shell-chrome';
import { Composer, type PendingAttachment } from './Composer';
import { MessageList } from './MessageList';
import { SidePanel } from './SidePanel';

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

export function ChatView({
  session,
  onTitleChange,
}: {
  session: SessionSummary;
  /** Titre dérivé du premier message (la colonne de gauche le reprend aussitôt). */
  onTitleChange?: (title: string) => void;
}) {
  const { state } = useApp();
  const { sidebarOpen } = useShellChrome();
  const { actions } = useChat();
  const view = useSessionView(session.id);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Le main nomme la session d'après le premier message : même règle ici.
  const [title, setTitle] = useState(session.title);
  const [panelOpen, setPanelOpen] = useState(true);
  const panelId = useId();
  const [error, setError] = useState<string | undefined>();
  const dragDepth = useRef(0);
  const running = isRunning(view);

  useEffect(() => {
    if (view.loaded) return;
    actions.open(session.id).catch((e: unknown) => {
      setError(errorMessage(toSerializedError(e)));
    });
  }, [actions, session.id, view.loaded]);

  // Vignettes `blob:` créées : toutes libérées à la fermeture.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);
  const revoke = (url: string | undefined): void => {
    if (!url) return;
    URL.revokeObjectURL(url);
    previews.current.delete(url);
  };

  const importFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setImporting(true);
    setError(undefined);
    try {
      const result = await atelier().importDroppedFiles(session.id, files);
      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }
      setPending((current) => [
        ...current,
        ...result.value.map((attachment, i) => {
          const file = files[i];
          if (file?.type.startsWith('image/') !== true) return { attachment };
          const previewUrl = URL.createObjectURL(file);
          previews.current.add(previewUrl);
          return { attachment, previewUrl };
        }),
      ]);
    } finally {
      setImporting(false);
    }
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const attachments = pending.map((p) => p.attachment);
    if (text === '' && attachments.length === 0) return;
    setError(undefined);
    if (!view.messages.some((m) => m.role === 'user')) {
      const next = deriveSessionTitle(text, attachments[0]?.name);
      setTitle(next);
      onTitleChange?.(next);
    }
    setDraft('');
    for (const p of pending) revoke(p.previewUrl);
    setPending([]);
    try {
      await actions.send(session.id, text, attachments);
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    }
  };

  const guard = (task: Promise<void>): void => {
    task.catch((e: unknown) => {
      setError(errorMessage(toSerializedError(e)));
    });
  };

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 border-b pr-4 [-webkit-app-region:drag]',
          headerInset(sidebarOpen),
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
          <SidebarOpenButton />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">{title}</h1>
            <p
              className="flex items-center gap-1 truncate text-xs text-muted-foreground"
              title={session.workspace}
            >
              <Folder className="size-3" aria-hidden />
              {fileName(session.workspace)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          <ServerStatusBadge status={state.server} />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Panneau de suivi"
            aria-expanded={panelOpen}
            aria-controls={panelId}
            title={panelOpen ? 'Masquer le suivi' : 'Afficher le suivi'}
            onClick={() => {
              setPanelOpen((open) => !open);
            }}
          >
            <PanelRight className="size-4" aria-hidden />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {view.messages.length === 0 && !view.live && view.loaded ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <h2 className="text-lg font-semibold">Que puis-je faire pour vous ?</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Je travaille dans le dossier « {fileName(session.workspace)} » : je peux lire vos
                documents, en créer de nouveaux, chercher sur internet et faire des calculs.
              </p>
            </div>
          ) : (
            <MessageList
              view={view}
              onRetry={() => {
                guard(actions.retry(session.id));
              }}
            />
          )}

          {error ? (
            <div className="mx-auto w-full max-w-3xl px-6 pb-2">
              <Alert tone="error">{error}</Alert>
            </div>
          ) : null}

          <Composer
            value={draft}
            onChange={setDraft}
            attachments={pending}
            onRemoveAttachment={(index) => {
              setPending((current) => {
                const removed = current[index];
                revoke(removed?.previewUrl);
                return current.filter((_, i) => i !== index);
              });
            }}
            onSend={() => void send()}
            onStop={() => {
              guard(actions.stop(session.id));
            }}
            running={running}
            disabled={!view.loaded}
            importing={importing}
          />
        </div>
        {panelOpen ? <SidePanel id={panelId} view={view} /> : null}
      </div>

      {dragging ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/50 bg-background/90 text-sm"
        >
          <Upload className="size-6 text-muted-foreground" />
          Déposez vos fichiers : ils seront copiés dans le dossier de travail.
        </div>
      ) : null}
    </div>
  );
}
