/**
 * Liste de conversations de la colonne de gauche : un clic ouvre la
 * conversation, le menu « … » propose Supprimer (avec confirmation). Une pastille
 * signale l'activité : jade qui pulse quand l'assistant travaille, ambre quand il
 * attend votre accord.
 */
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { SessionSummary } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { fileName, relativeTime } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import { ActionMenu } from './ActionMenu';
import { ACTIVITY_LABELS, type SessionActivity } from './activity';

function ActivityDot({ activity }: { activity: SessionActivity }) {
  return (
    <span className="relative flex size-2 shrink-0" title={ACTIVITY_LABELS[activity]}>
      {activity === 'running' ? (
        <span
          className="absolute inline-flex size-full rounded-full bg-brand opacity-60 motion-safe:animate-ping"
          aria-hidden
        />
      ) : null}
      <span
        className={cn(
          'relative inline-flex size-2 rounded-full',
          activity === 'running' ? 'bg-brand' : 'bg-warning',
        )}
        aria-hidden
      />
      <span className="sr-only">{ACTIVITY_LABELS[activity]}</span>
    </span>
  );
}

export function ConversationList({
  sessions,
  currentId,
  onOpen,
  onDelete,
  showFolder = false,
  label,
  activity,
}: {
  sessions: readonly SessionSummary[];
  currentId: string | undefined;
  onOpen: (session: SessionSummary) => void;
  /** Supprime la conversation (après confirmation). */
  onDelete: (session: SessionSummary) => Promise<void>;
  /** Affiche le dossier sous le titre (Récentes, résultats de recherche). */
  showFolder?: boolean;
  label: string;
  /** Conversations où l'assistant travaille ou attend un accord. */
  activity?: ReadonlyMap<string, SessionActivity>;
}) {
  const [confirming, setConfirming] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async (session: SessionSummary): Promise<void> => {
    setDeleting(true);
    try {
      await onDelete(session);
    } finally {
      setDeleting(false);
      setConfirming(undefined);
    }
  };

  return (
    <ul aria-label={label} className="space-y-0.5">
      {sessions.map((session) => {
        const current = session.id === currentId;
        if (confirming === session.id) {
          return (
            <li
              key={session.id}
              className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-2"
            >
              <p className="text-xs">
                Supprimer « <span className="font-medium">{session.title}</span> » ? Les fichiers du
                dossier sont conservés.
              </p>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7"
                  disabled={deleting}
                  onClick={() => void confirmDelete(session)}
                >
                  Supprimer
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  autoFocus
                  onClick={() => {
                    setConfirming(undefined);
                  }}
                >
                  Annuler
                </Button>
              </div>
            </li>
          );
        }
        const busy = activity?.get(session.id);
        return (
          <li
            key={session.id}
            className={cn(
              'group flex items-center gap-1 rounded-md pr-1',
              current ? 'bg-brand-soft' : 'hover:bg-accent/60',
            )}
          >
            <button
              type="button"
              aria-current={current ? 'page' : undefined}
              onClick={() => {
                onOpen(session);
              }}
              title={session.title}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-sm', current ? 'font-medium' : undefined)}>
                  {session.title}
                </span>
                {showFolder ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {fileName(session.workspace)} · {relativeTime(session.updatedAt)}
                  </span>
                ) : null}
              </span>
              {busy ? <ActivityDot activity={busy} /> : null}
            </button>
            <ActionMenu
              label={`Actions pour « ${session.title} »`}
              className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100"
              items={[
                {
                  label: 'Supprimer',
                  icon: Trash2,
                  destructive: true,
                  onSelect: () => {
                    setConfirming(session.id);
                  },
                },
              ]}
            />
          </li>
        );
      })}
    </ul>
  );
}
