import type { ServerStatus } from '@atelier/shared';
import { cn } from '@renderer/lib/utils';

const LABELS: Record<ServerStatus['health'], string> = {
  connected: 'Serveur connecté',
  slow: 'Serveur lent',
  offline: 'Serveur hors ligne',
  unknown: 'Serveur : vérification…',
};

const DOTS: Record<ServerStatus['health'], string> = {
  connected: 'bg-emerald-500',
  slow: 'bg-amber-500',
  offline: 'bg-red-500',
  unknown: 'bg-muted-foreground/50',
};

/** Texte complet (infobulle et lecteurs d'écran). */
export function serverStatusText(status: ServerStatus): string {
  const base = LABELS[status.health];
  return status.latencyMs !== undefined && status.health !== 'offline'
    ? `${base} (${String(status.latencyMs)} ms)`
    : base;
}

/** Indicateur permanent de l'état du serveur LLM. */
export function ServerStatusBadge({
  status,
  className,
}: {
  status: ServerStatus;
  className?: string;
}) {
  const text = serverStatusText(status);
  return (
    <span
      role="status"
      title={text}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground',
        className,
      )}
    >
      <span className={cn('size-2 rounded-full', DOTS[status.health])} aria-hidden />
      {text}
    </span>
  );
}
