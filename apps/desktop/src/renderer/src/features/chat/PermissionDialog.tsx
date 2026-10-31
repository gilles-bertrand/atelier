/**
 * Modale de permission : « Autoriser une fois / Toujours pour cette
 * conversation / Refuser ». Une seule demande affichée à la fois ; Échap refuse.
 */
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import {
  Brain,
  FilePen,
  Globe,
  Plug,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionDecision, PermissionKind, PermissionRequest } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';

/**
 * Niveau de risque, porté par la couleur : rouge pour une suppression ; ambre pour
 * une commande, internet, un connecteur qui écrit ou une action inconnue ; bleu
 * pour l'écriture d'un fichier du dossier de travail.
 */
export type PermissionRisk = 'high' | 'medium' | 'low';

export const PERMISSION_KINDS: Record<
  PermissionKind,
  { icon: LucideIcon; heading: string; risk: PermissionRisk; allowLabel?: string }
> = {
  file_write: { icon: FilePen, heading: 'Modifier un fichier', risk: 'low' },
  file_delete: {
    icon: Trash2,
    heading: 'Supprimer un fichier',
    risk: 'high',
    allowLabel: 'Supprimer une fois',
  },
  command: { icon: SquareTerminal, heading: 'Exécuter une commande', risk: 'medium' },
  network: { icon: Globe, heading: 'Accéder à internet', risk: 'medium' },
  mcp_write: { icon: Plug, heading: 'Utiliser un connecteur', risk: 'medium' },
  // Risque moyen : la mémoire revient dans chaque conversation du projet, une
  // injection lue dans un fichier ou sur le web y persisterait (ADR-003 D4).
  memory_write: { icon: Brain, heading: 'Retenir dans la mémoire du projet', risk: 'medium' },
  other: { icon: ShieldAlert, heading: 'Autoriser une action', risk: 'medium' },
};

const RISK_CLASSES: Record<PermissionRisk, string> = {
  high: 'bg-destructive-soft text-destructive-text',
  medium: 'bg-warning-soft text-warning-text',
  low: 'bg-info-soft text-info-text',
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
  const kind = PERMISSION_KINDS[request.kind];
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
          <span
            data-risk={kind.risk}
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-full',
              RISK_CLASSES[kind.risk],
            )}
          >
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
            variant={kind.risk === 'high' ? 'destructive' : 'default'}
            onClick={() => {
              onDecide('allow_once');
            }}
          >
            {kind.allowLabel ?? 'Autoriser une fois'}
          </Button>
        </div>
      </div>
    </div>
  );
}
