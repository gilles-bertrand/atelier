/**
 * Affichage des prompts planifiés (ADR-002) : libellés, dates relatives,
 * aperçu des prochaines exécutions et « Autoriser pour cette tâche ».
 * Fonctions pures, testées sans DOM.
 */
import {
  nextRunAt,
  validateSchedule,
  type DeniedAction,
  type Schedule,
  type ScheduledPermissions,
  type ScheduledRunSkipReason,
  type ScheduledRunStatus,
  type ScheduledRunTrigger,
  type UsagePeriod,
} from '@atelier/shared';
import type { StatusTone } from '@renderer/components/status/StatusDot';
import { localDay, periodStartDay } from '../../../common/usage-days';

export const RUN_STATUS_LABELS: Record<ScheduledRunStatus, string> = {
  queued: 'En file',
  running: 'En cours',
  success: 'Réussi',
  error: 'Échec',
  timeout: 'Trop long',
  aborted: 'Arrêté',
  skipped: 'Sauté',
  interrupted: 'Interrompu',
};

/** Ton de la pastille d'un statut (la couleur n'est jamais seule : le libellé suit). */
export const RUN_STATUS_TONES: Record<ScheduledRunStatus, StatusTone> = {
  queued: 'idle',
  running: 'busy',
  success: 'ok',
  error: 'error',
  timeout: 'error',
  aborted: 'warning',
  skipped: 'warning',
  interrupted: 'warning',
};

export const TRIGGER_LABELS: Record<ScheduledRunTrigger, string> = {
  schedule: 'Planifié',
  catch_up: 'Rattrapage',
  manual: 'Manuel',
};

export const SKIP_REASON_LABELS: Record<ScheduledRunSkipReason, string> = {
  overlap: 'l’exécution précédente tournait encore',
  busy: 'la machine isolée est restée occupée',
  disabled_model: 'le modèle n’est plus disponible',
};

/** Les `count` prochaines exécutions après `from` ; vide si la récurrence est invalide. */
export function upcomingRuns(schedule: Schedule, from: Date, count = 3): Date[] {
  if (validateSchedule(schedule) !== undefined) return [];
  const out: Date[] = [];
  let after = from;
  for (let i = 0; i < count; i += 1) {
    after = nextRunAt(schedule, after);
    out.push(after);
  }
  return out;
}

const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const shortDate = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });
const weekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long' });

/** « 31/10 à 08:00 » */
export function formatRunDate(date: Date): string {
  return `${shortDate.format(date)} à ${time.format(date)}`;
}

/** « jeudi 31 oct. à 08:00 » (aperçu des prochaines exécutions). */
export function formatUpcoming(date: Date): string {
  return `${weekday.format(date)} ${dayMonth.format(date)} à ${time.format(date)}`;
}

/**
 * Échéance relative : « dans 12 min », « dans 3 h », « demain à 08:00 »,
 * « le 3 nov. à 08:00 » ; « en retard » si elle est passée.
 */
export function relativeNext(at: Date, now: Date): string {
  const diff = at.getTime() - now.getTime();
  if (diff < 0) return 'en retard';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'dans moins d’une minute';
  if (minutes < 60) return `dans ${String(minutes)} min`;
  if (localDay(at) === localDay(now)) return `dans ${String(Math.round(minutes / 60))} h`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (localDay(at) === localDay(tomorrow)) return `demain à ${time.format(at)}`;
  return `le ${dayMonth.format(at)} à ${time.format(at)}`;
}

/** « 45 s », « 2 min 05 s », « 1 h 03 min ». */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export interface RunDayBar {
  day: string;
  success: number;
  error: number;
  skipped: number;
}

/** Barres quotidiennes des runs ; les jours sans run sont inclus sur 7 j et 30 j. */
export function runDayBars(
  daily: readonly RunDayBar[],
  period: UsagePeriod,
  now: Date,
): RunDayBar[] {
  const byDay = new Map<string, RunDayBar>();
  const start = periodStartDay(period, now);
  if (start !== undefined) {
    const [y, m, d] = start.split('-').map(Number);
    for (
      let day = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
      localDay(day) <= localDay(now);
      day.setDate(day.getDate() + 1)
    ) {
      byDay.set(localDay(day), { day: localDay(day), success: 0, error: 0, skipped: 0 });
    }
  }
  for (const point of daily) byDay.set(point.day, { ...point });
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Domaine d'une portée `web_fetch:<domaine>`. */
function domainOf(scopeKey: string): string | undefined {
  return scopeKey.startsWith('web_fetch:') ? scopeKey.slice('web_fetch:'.length) : undefined;
}

/**
 * « Autoriser pour cette tâche » (D4) : la politique avec les cases des actions
 * refusées pré-cochées. Les suppressions et les actions inconnues ne sont
 * jamais autorisables : elles sont renvoyées à part, pour l'expliquer.
 */
export function permissionsAfterDenied(
  current: ScheduledPermissions,
  denied: readonly DeniedAction[],
): { permissions: ScheduledPermissions; notGrantable: DeniedAction[] } {
  const next: ScheduledPermissions = {
    ...current,
    webDomains: current.webDomains === '*' ? '*' : [...current.webDomains],
    mcpTools: [...current.mcpTools],
  };
  const notGrantable: DeniedAction[] = [];
  for (const action of denied) {
    switch (action.kind) {
      case 'file_write':
        next.fileWrite = true;
        break;
      case 'command':
        next.commands = true;
        break;
      case 'network': {
        const domain = domainOf(action.scopeKey);
        if (domain === undefined) notGrantable.push(action);
        else if (next.webDomains !== '*' && !next.webDomains.includes(domain)) {
          next.webDomains.push(domain);
        }
        break;
      }
      case 'mcp_write':
        if (!next.mcpTools.includes(action.scopeKey)) next.mcpTools.push(action.scopeKey);
        break;
      default:
        notGrantable.push(action);
    }
  }
  return { permissions: next, notGrantable };
}

/** Liste saisie (virgules, espaces ou lignes) → éléments uniques, sans vide. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
