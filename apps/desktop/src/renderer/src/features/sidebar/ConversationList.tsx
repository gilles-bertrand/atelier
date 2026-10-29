/**
 * Liste de conversations de la colonne de gauche : un clic ouvre la
 * conversation, le menu « … » propose Supprimer (avec confirmation).
 */
import { useState } from 'react';
import type { SessionSummary } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { fileName, relativeTime } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import { ActionMenu } from './ActionMenu';

export function ConversationList({
  sessions,
  currentId,
  onOpen,
  onDelete,
  showFolder = false,
  label,
}: {
  sessions: readonly SessionSummary[];
  currentId: string | undefined;
  onOpen: (session: SessionSummary) => void;
  /** Supprime la conversation (après confirmation). */
  onDelete: (session: SessionSummary) => Promise<void>;
  /** Affiche le dossier sous le titre (Récentes, résultats de recherche). */
  showFolder?: boolean;
  label: string;
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
        return (
          <li
            key={session.id}
            className={cn(
              'group flex items-center gap-1 rounded-md pr-1',
              current ? 'bg-accent' : 'hover:bg-accent/60',
            )}
          >
            <button
              type="button"
              aria-current={current ? 'page' : undefined}
              onClick={() => {
                onOpen(session);
              }}
              title={session.title}
              className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={cn('block truncate text-sm', current ? 'font-medium' : undefined)}>
                {session.title}
              </span>
              {showFolder ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {fileName(session.workspace)} · {relativeTime(session.updatedAt)}
                </span>
              ) : null}
            </button>
            <ActionMenu
              label={`Actions pour « ${session.title} »`}
              className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100"
              items={[
                {
                  label: 'Supprimer',
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
