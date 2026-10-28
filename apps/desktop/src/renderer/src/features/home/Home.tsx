/**
 * Accueil : choisir un dossier de travail pour une nouvelle conversation, ou
 * reprendre une conversation récente.
 */
import { useEffect, useState } from 'react';
import { Folder, FolderPlus, Loader2, MessageSquare, Trash2 } from 'lucide-react';
import type { SessionSummary } from '@atelier/shared';
import { ServerStatusBadge } from '@renderer/components/status/ServerStatusBadge';
import { Button } from '@renderer/components/ui/button';
import { Alert } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { fileName, relativeTime } from '@renderer/lib/tool-labels';
import { useApp } from '@renderer/state/app-state';

export function Home({
  onOpen,
  onDeleted,
}: {
  onOpen: (session: SessionSummary) => void;
  onDeleted: (sessionId: string) => void;
}) {
  const { state } = useApp();
  const [sessions, setSessions] = useState<SessionSummary[] | undefined>();
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    call('session:list', { limit: 30 }).then(
      (list) => {
        if (!cancelled) setSessions(list);
      },
      (e: unknown) => {
        if (!cancelled) {
          setSessions([]);
          setError(errorMessage(toSerializedError(e)));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseFolder = async (): Promise<void> => {
    setChoosing(true);
    setError(undefined);
    try {
      const workspace = await call('workspace:choose');
      if (workspace === null) return;
      onOpen(await call('session:create', { workspace }));
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    } finally {
      setChoosing(false);
    }
  };

  const remove = async (session: SessionSummary): Promise<void> => {
    setError(undefined);
    try {
      await call('session:delete', { sessionId: session.id });
      setSessions((list) => list?.filter((s) => s.id !== session.id));
      onDeleted(session.id);
    } catch (e) {
      setError(errorMessage(toSerializedError(e)));
    } finally {
      setConfirming(undefined);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center justify-end border-b pl-20 pr-4 [-webkit-app-region:drag]">
        <ServerStatusBadge status={state.server} className="[-webkit-app-region:no-drag]" />
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-10 px-6 py-12">
          <section className="space-y-4 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">Sur quoi travaille-t-on ?</h1>
            <p className="text-sm text-muted-foreground">
              Choisissez le dossier qui contient vos documents. L’assistant pourra les lire, en
              créer de nouveaux et les modifier avec votre accord.
            </p>
            <Button size="lg" onClick={() => void chooseFolder()} disabled={choosing}>
              {choosing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <FolderPlus className="size-4" aria-hidden />
              )}
              Choisir un dossier
            </Button>
          </section>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <section aria-labelledby="recent-title" className="space-y-3">
            <h2 id="recent-title" className="text-sm font-medium text-muted-foreground">
              Conversations récentes
            </h2>
            {sessions === undefined ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Chargement…
              </p>
            ) : sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune conversation pour l’instant.</p>
            ) : (
              <ul className="divide-y rounded-xl border bg-card">
                {sessions.map((session) => (
                  <li key={session.id} className="flex items-center gap-2 pr-2">
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(session);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <MessageSquare
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{session.title}</span>
                        <span
                          className="flex items-center gap-1 truncate text-xs text-muted-foreground"
                          title={session.workspace}
                        >
                          <Folder className="size-3" aria-hidden />
                          {fileName(session.workspace)} · {relativeTime(session.updatedAt)}
                        </span>
                      </span>
                    </button>
                    {confirming === session.id ? (
                      <span className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void remove(session)}
                        >
                          Supprimer
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setConfirming(undefined);
                          }}
                        >
                          Annuler
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Supprimer la conversation « ${session.title} »`}
                        onClick={() => {
                          setConfirming(session.id);
                        }}
                      >
                        <Trash2 className="size-4 text-muted-foreground" aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
