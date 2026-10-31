/** Textes des notifications macOS de fin de run (ADR-002 D7). */
import type { ScheduledRun } from '@atelier/shared';

/** Notification macOS de fin de run (ADR-002 D7) : « Rapport hebdo · terminé, 2 fichiers ». */
export function runNotificationBody(run: ScheduledRun): string {
  if (run.status === 'success') {
    const files = run.files.length;
    const produced = files === 0 ? '' : `, ${String(files)} fichier${files > 1 ? 's' : ''}`;
    const denied = run.denied.length;
    const refused =
      denied === 0
        ? ''
        : ` · ${String(denied)} action${denied > 1 ? 's' : ''} refusée${denied > 1 ? 's' : ''}`;
    return `terminé${produced}${refused}`;
  }
  if (run.status === 'timeout') return 'arrêté : durée maximale dépassée';
  if (run.status === 'aborted') return 'arrêté';
  return 'échec';
}
