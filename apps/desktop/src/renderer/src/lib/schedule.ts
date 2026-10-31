/**
 * Affichage des prompts planifiés (ADR-002) : libellés, dates relatives,
 * aperçu des prochaines exécutions et « Autoriser pour cette tâche ».
 * Fonctions pures, testées sans DOM.
 */
import {
  nextRunAt,
  validateSchedule,
  type DeniedAction,
  type McpServerStatus,
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

/** Serveur d'un nom d'outil `mcp__<serveur>__<outil>` (`undefined` hors de ce format). */
export function mcpServerOf(tool: string): string | undefined {
  return /^mcp__(.+?)__.+$/.exec(tool)?.[1];
}

/** Outil en écriture d'un serveur connecté (case à cocher du formulaire). */
export interface WritableMcpTool {
  name: string;
  /** Titre annoncé, sinon le nom court de l'outil. */
  label: string;
}

/** Pourquoi un outil enregistré ne peut pas être coché dans la liste du serveur. */
export type UnavailableReason = 'missing_server' | 'disconnected' | 'missing_tool';

/**
 * Cases des connecteurs en écriture (D4) : outils `readOnly: false` des serveurs
 * connectés, groupés par serveur ; et outils déjà enregistrés qu'on ne retrouve
 * pas dans ces groupes, gardés visibles avec la raison.
 */
export function mcpToolChoices(
  servers: readonly McpServerStatus[],
  selected: readonly string[],
): {
  groups: { server: string; connected: boolean; tools: WritableMcpTool[] }[];
  unavailable: { name: string; reason: UnavailableReason }[];
} {
  const groups = servers.map((server) => ({
    server: server.name,
    connected: server.tools !== undefined,
    tools: (server.tools ?? [])
      .filter((tool) => !tool.readOnly)
      .map((tool) => ({
        name: tool.name,
        label: tool.title ?? tool.name.replace(`mcp__${server.name}__`, ''),
      })),
  }));
  const listed = new Set(groups.flatMap((g) => g.tools.map((t) => t.name)));
  const unavailable = selected
    .filter((name) => !listed.has(name))
    .map((name) => {
      const server = servers.find((s) => s.name === mcpServerOf(name));
      const reason: UnavailableReason = !server
        ? 'missing_server'
        : server.tools === undefined
          ? 'disconnected'
          : 'missing_tool';
      return { name, reason };
    });
  return { groups, unavailable };
}

/**
 * Compte rendu d'un run en texte simple, pour une cellule du tableau de bord
 * (#116) : emphase, titres, puces, citations, code et liens réduits à leur
 * texte, lignes jointes par « · ». Jamais de rendu HTML : le texte vient du modèle.
 */
export function plainSummary(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*```.*$/, '')
        .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/, '')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
        .replace(/<\/?[a-z][^>]*>/gi, '')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line !== '')
    .join(' · ');
}
