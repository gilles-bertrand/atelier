import type { ServerStatus } from '@atelier/shared';
import { cn } from '@renderer/lib/utils';
import { StatusDot, type StatusTone } from './StatusDot';

const LABELS: Record<ServerStatus['health'], string> = {
  connected: 'Serveur connecté',
  slow: 'Serveur lent',
  offline: 'Serveur hors ligne',
  unknown: 'Serveur : vérification…',
};

export const SERVER_TONES: Record<ServerStatus['health'], StatusTone> = {
  connected: 'ok',
  slow: 'warning',
  offline: 'error',
  unknown: 'idle',
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
      <StatusDot tone={SERVER_TONES[status.health]} />
      {text}
    </span>
  );
}
