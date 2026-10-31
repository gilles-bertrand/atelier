/**
 * Bandeau d'une conversation créée par un run planifié (ADR-002 D7) :
 * « Exécution planifiée de “Rapport” du 31/10 à 08:00 », statut, refus, et
 * « Autoriser pour cette tâche » qui ouvre le formulaire avec les cases pré-cochées.
 */
import { useEffect, useState } from 'react';
import { CalendarClock, ShieldCheck } from 'lucide-react';
import type { DeniedAction, ScheduledRun } from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { atelier, call } from '@renderer/lib/api';
import { formatRunDate } from '@renderer/lib/schedule';
import { RunStatus } from './ScheduleView';

/** Runs relus pour retrouver celui de la conversation. */
const RUN_LOOKUP_LIMIT = 200;

export function RunBanner({
  sessionId,
  taskId,
  onAuthorize,
}: {
  sessionId: string;
  taskId: string;
  onAuthorize?: (taskId: string, denied: DeniedAction[]) => void;
}) {
  const [run, setRun] = useState<ScheduledRun | undefined>();

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      call('schedule:runs', { taskId, limit: RUN_LOOKUP_LIMIT }).then(
        (runs) => {
          if (!cancelled) setRun(runs.find((r) => r.sessionId === sessionId));
        },
        () => undefined,
      );
    };
    load();
    const off = atelier().on('schedule:changed', (change) => {
      if (change.taskId === taskId) load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [sessionId, taskId]);

  if (!run) return null;
  const denied = run.denied.length;
  return (
    <div
      role="note"
      aria-label="Exécution planifiée"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/30 px-6 py-2 text-sm"
    >
      <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>
        Exécution planifiée de « {run.taskName} » du {formatRunDate(new Date(run.scheduledFor))}
      </span>
      <RunStatus run={run} />
      {denied > 0 ? (
        <>
          <span className="text-warning-text">
            {denied} action{denied > 1 ? 's' : ''} refusée{denied > 1 ? 's' : ''}
          </span>
          {onAuthorize ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => {
                onAuthorize(taskId, run.denied);
              }}
            >
              <ShieldCheck className="size-3.5" aria-hidden />
              Autoriser pour cette tâche
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
