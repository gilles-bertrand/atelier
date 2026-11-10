/**
 * Liste de conversations de la colonne de gauche : un clic ouvre la
 * conversation, le menu « … » propose Déplacer vers le projet… et Supprimer
 * (avec confirmation). Une ligne se glisse sur un projet ou sur « Dossiers »
 * (#21, voir `session-move.tsx`). Une pastille signale l'activité : jade qui
 * pulse quand l'assistant travaille, ambre quand il attend votre accord.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Folder, FolderInput, FolderKanban, Trash2 } from 'lucide-react';
import type { SessionSummary } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { fileName, relativeTime } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import { ActionMenu } from './ActionMenu';
import { ACTIVITY_LABELS, type SessionActivity } from './activity';
import { canMove, compatibleProjects, dragSource, type SessionMoveState } from './session-move';

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

/**
 * « Déplacer vers le projet… » : projets où la conversation peut entrer, et
 * « Hors projet » si elle est dans un projet. Même règle que le glisser-déposer.
 */
function MovePanel({
  session,
  move,
  onClose,
}: {
  session: SessionSummary;
  move: SessionMoveState;
  onClose: () => void;
}) {
  const titleId = useId();
  const targets = compatibleProjects(session, move.projects);
  const canLeave = session.projectId !== undefined;
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  const option =
    'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none';
  return (
    <li className="rounded-md border bg-background px-2 py-2" onKeyDown={onKeyDown}>
      <div role="group" aria-labelledby={titleId} className="space-y-1.5">
        <p id={titleId} className="text-xs">
          Déplacer « <span className="font-medium">{session.title}</span> » vers :
        </p>
        {targets.length > 0 || canLeave ? (
          <ul aria-label="Destinations" className="space-y-0.5">
            {targets.map((project, index) => (
              <li key={project.id}>
                <button
                  type="button"
                  className={option}
                  autoFocus={index === 0}
                  onClick={() => {
                    onClose();
                    move.move(session, project);
                  }}
                >
                  <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{project.name}</span>
                </button>
              </li>
            ))}
            {canLeave ? (
              <li>
                <button
                  type="button"
                  className={option}
                  autoFocus={targets.length === 0}
                  onClick={() => {
                    onClose();
                    move.move(session, null);
                  }}
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  Hors projet
                </button>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            Aucun projet ne travaille dans le dossier « {fileName(session.workspace)} ». Pour y
            ranger cette conversation, créez un projet à partir de ce dossier.
          </p>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          autoFocus={targets.length === 0 && !canLeave}
          onClick={onClose}
        >
          Annuler
        </Button>
      </div>
    </li>
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
  move,
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
  /**
   * Déplacement entre projets (#21) : lignes glissables et « Déplacer vers le
   * projet… ». Absent : ni l'un ni l'autre.
   */
  move?: SessionMoveState | undefined;
}) {
  const [confirming, setConfirming] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState<string | undefined>();
  const listRef = useRef<HTMLUListElement>(null);
  // Panneau en ligne refermé (déplacement, suppression annulée) : le focus revient
  // au bouton « … » de sa ligne, comme à la fermeture d'ActionMenu.
  const focusActionsOf = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = focusActionsOf.current;
    if (id === undefined) return;
    focusActionsOf.current = undefined;
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [],
    ).find((el) => el.dataset['sessionId'] === id);
    row?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
  });

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
    <ul ref={listRef} aria-label={label} className="space-y-0.5">
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
                    focusActionsOf.current = session.id;
                    setConfirming(undefined);
                  }}
                >
                  Annuler
                </Button>
              </div>
            </li>
          );
        }
        if (moving === session.id && move) {
          return (
            <MovePanel
              key={session.id}
              session={session}
              move={move}
              onClose={() => {
                focusActionsOf.current = session.id;
                setMoving(undefined);
              }}
            />
          );
        }
        const busy = activity?.get(session.id);
        const drag = dragSource(move, session);
        return (
          <li
            key={session.id}
            data-session-id={session.id}
            draggable={drag.draggable || undefined}
            {...drag.props}
            className={cn(
              'group flex items-center gap-1 rounded-md pr-1',
              current ? 'bg-brand-soft' : 'hover:bg-accent/60',
              drag.dragging ? 'opacity-50' : undefined,
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
                ...(move && canMove(session)
                  ? [
                      {
                        label: 'Déplacer vers le projet…',
                        icon: FolderInput,
                        onSelect: () => {
                          setMoving(session.id);
                        },
                      },
                    ]
                  : []),
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
