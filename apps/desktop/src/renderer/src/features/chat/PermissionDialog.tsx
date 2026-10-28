/**
 * Modale de permission : « Autoriser une fois / Toujours pour cette
 * conversation / Refuser ». Une seule demande affichée à la fois ; Échap refuse.
 */
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { FilePen, Globe, Plug, ShieldAlert, Terminal, Trash2 } from 'lucide-react';
import type { PermissionDecision, PermissionKind, PermissionRequest } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';

const KIND: Record<PermissionKind, { icon: typeof Globe; heading: string }> = {
  file_write: { icon: FilePen, heading: 'Modifier un fichier' },
  file_delete: { icon: Trash2, heading: 'Supprimer un fichier' },
  command: { icon: Terminal, heading: 'Exécuter une commande' },
  network: { icon: Globe, heading: 'Accéder à internet' },
  mcp_write: { icon: Plug, heading: 'Utiliser un connecteur' },
  other: { icon: ShieldAlert, heading: 'Autoriser une action' },
};

export function PermissionDialog({
  request,
  sessionTitle,
  onDecide,
}: {
  request: PermissionRequest;
  /** Titre de la conversation, si elle n'est pas celle affichée. */
  sessionTitle?: string;
  onDecide: (decision: PermissionDecision) => void;
}) {
  const titleId = useId();
  const descId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const firstButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<Element | null>(null);
  const kind = KIND[request.kind];
  const Icon = kind.icon;

  useEffect(() => {
    previousFocus.current = document.activeElement;
    firstButton.current?.focus();
    return () => {
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
    };
  }, [request.id]);

  // Piège à focus : Tab reste dans la modale ; Échap refuse.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDecide('deny');
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const buttons = Array.from(dialog.current.querySelectorAll<HTMLButtonElement>('button'));
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg space-y-4 rounded-xl border bg-background p-6 shadow-lg"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {kind.heading}
              {sessionTitle ? ` · ${sessionTitle}` : ''}
            </p>
            <h2 id={titleId} className="text-base font-semibold break-words">
              {request.title}
            </h2>
          </div>
        </div>
        <div id={descId} className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            L’assistant demande votre accord avant de continuer.
          </p>
          {request.detail ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {request.detail}
            </pre>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            ref={firstButton}
            variant="outline"
            onClick={() => {
              onDecide('deny');
            }}
          >
            Refuser
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onDecide('allow_session');
            }}
          >
            Toujours pour cette conversation
          </Button>
          <Button
            onClick={() => {
              onDecide('allow_once');
            }}
          >
            Autoriser une fois
          </Button>
        </div>
      </div>
    </div>
  );
}
