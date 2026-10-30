/**
 * Pastille d'état (serveur, machine isolée, connecteurs) : une seule source pour
 * les couleurs d'état. Décorative : le libellé de l'état est toujours écrit à côté.
 */
import { Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/** `busy` : une opération est en cours (roue), les autres tons sont des pastilles. */
export type StatusTone = 'ok' | 'busy' | 'warning' | 'error' | 'idle';

const DOTS: Record<Exclude<StatusTone, 'busy'>, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/50',
};

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  if (tone === 'busy') {
    return (
      <Loader2
        data-tone={tone}
        className={cn('size-3.5 shrink-0 animate-spin text-muted-foreground', className)}
        aria-hidden
      />
    );
  }
  return (
    <span
      data-tone={tone}
      className={cn('size-2 shrink-0 rounded-full', DOTS[tone], className)}
      aria-hidden
    />
  );
}
