/**
 * Prompts planifiés (tâches récurrentes) et tableau de bord de leurs exécutions.
 * Voir `docs/adr/ADR-002-prompts-planifies.md`.
 *
 * Types et fonctions pures, sans dépendance : le main (scheduler, notifications)
 * et le renderer (formulaire, aperçu des prochaines exécutions) partagent le
 * même calcul. Toutes les heures sont en heure locale du Mac.
 */
import type { SerializedAtelierError } from './errors.js';
import type { PermissionKind } from './permissions.js';
import type { UsagePeriod } from './usage.js';

/** Jour de la semaine ISO : 1 = lundi … 7 = dimanche. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Récurrence d'une tâche. `time` est une heure locale `HH:MM`.
 * - `interval` : `every × unit` (au moins {@link MIN_INTERVAL_MINUTES}), compté depuis le dernier run ;
 * - `monthly` : `day` est borné au dernier jour du mois (31 → 30 en avril, 28 ou 29 en février) ;
 * - `yearly` : le 29 février devient le 28 les années non bissextiles.
 */
export type Schedule =
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: IsoWeekday[]; time: string }
  | { kind: 'monthly'; day: number; time: string }
  | { kind: 'yearly'; month: number; day: number; time: string };

/** Intervalle minimal entre deux runs (un tour local dure de 30 s à plusieurs minutes). */
export const MIN_INTERVAL_MINUTES = 15;

/** Durée maximale d'un run par défaut, et ses bornes (minutes). */
export const DEFAULT_MAX_DURATION_MINUTES = 20;
export const MIN_MAX_DURATION_MINUTES = 5;
export const MAX_MAX_DURATION_MINUTES = 120;

/** Ce qu'une tâche a le droit de faire sans l'utilisateur (cases du formulaire, ADR-002 D4). */
export interface ScheduledPermissions {
  /** Créer et modifier des fichiers dans le dossier (`kind: 'file_write'`). */
  fileWrite: boolean;
  /** Exécuter des commandes dans la machine isolée (`kind: 'command'`). */
  commands: boolean;
  /** `'*'` = tous les domaines ; liste vide = pas d'accès aux pages web. */
  webDomains: '*' | string[];
  /** Noms complets `mcp__<serveur>__<outil>` autorisés en écriture. */
  mcpTools: string[];
  /**
   * Mettre à jour la mémoire du projet (`kind: 'memory_write'`, ADR-003 D4).
   * Absent = `false`. « Créer et modifier des fichiers » ne la couvre pas.
   */
  memory?: boolean;
}

/** Tâche telle que saisie dans le formulaire. */
export interface ScheduledTaskInput {
  name: string;
  /** Prompt envoyé comme premier message de chaque run. */
  prompt: string;
  /** Dossier de travail absolu (pour une tâche de projet : son dossier principal). */
  workspace: string;
  /**
   * Projet de la tâche (ADR-003 D6) : ses runs héritent des dossiers, des
   * consignes et de la mémoire du projet, et leurs conversations lui appartiennent.
   */
  projectId?: string;
  /** Modèle ; absent = modèle par défaut des Réglages au moment du run. */
  model?: string;
  schedule: Schedule;
  permissions: ScheduledPermissions;
  /** Durée maximale d'un run en minutes (défaut 20, de 5 à 120). */
  maxDurationMinutes?: number;
  /** Défaut `true`. */
  enabled?: boolean;
}

/** Tâche enregistrée. */
export interface ScheduledTask extends Required<Omit<ScheduledTaskInput, 'model' | 'projectId'>> {
  id: string;
  model?: string;
  projectId?: string;
  /** Prochaine exécution (ISO 8601) ; absente si la tâche est désactivée. */
  nextRunAt?: string;
  lastRun?: Pick<ScheduledRun, 'id' | 'status' | 'scheduledFor'>;
  createdAt: string;
  updatedAt: string;
}

/** Origine d'un run : l'horaire, le rattrapage au démarrage ou au réveil, ou « Exécuter maintenant ». */
export type ScheduledRunTrigger = 'schedule' | 'catch_up' | 'manual';

/**
 * État d'un run. `interrupted` : app quittée ou plantée pendant le run (pas une
 * erreur du modèle). `skipped` : occurrence non exécutée, voir {@link ScheduledRunSkipReason}.
 */
export type ScheduledRunStatus =
  'queued' | 'running' | 'success' | 'error' | 'timeout' | 'aborted' | 'skipped' | 'interrupted';

/**
 * Motif d'un run sauté : run précédent de la tâche encore en cours (`overlap`),
 * machine isolée occupée dans un autre dossier pendant 30 min (`busy`), modèle
 * de la tâche inutilisable (`disabled_model`).
 */
export type ScheduledRunSkipReason = 'overlap' | 'busy' | 'disabled_model';

/** Action refusée pendant un run (politique non interactive). */
export interface DeniedAction {
  toolName: string;
  kind: PermissionKind;
  /** Clé de portée de la demande (`write_file`, `web_fetch:<domaine>`, `mcp__<serveur>__<outil>`…). */
  scopeKey: string;
  /** Libellé de la demande, tel qu'il aurait été affiché dans la modale. */
  title: string;
}

/** Exécution d'une tâche. */
export interface ScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  /** Conversation du run (absente pour un run sauté ou si elle a été supprimée). */
  sessionId?: string;
  trigger: ScheduledRunTrigger;
  status: ScheduledRunStatus;
  skipReason?: ScheduledRunSkipReason;
  /** Horaire prévu (ISO 8601). */
  scheduledFor: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Tokens d'entrée et de sortie du tour (registre d'utilisation). */
  totalTokens?: number;
  /** Début du compte rendu final (5 lignes, 500 caractères au plus). */
  summary?: string;
  /** Fichiers produits, chemins relatifs au dossier de la tâche. */
  files: string[];
  denied: DeniedAction[];
  error?: SerializedAtelierError;
}

/** Réponse de `schedule:dashboard`. */
export interface ScheduleDashboard {
  period: UsagePeriod;
  activeTasks: number;
  /** Prochaine exécution, toutes tâches confondues (ISO 8601). */
  nextRunAt?: string;
  /** Runs de la période. */
  runs: number;
  /** Taux de réussite (0..1), hors runs `skipped` et `interrupted` ; absent sans run. */
  successRate?: number;
  avgDurationMs?: number;
  totalTokens: number;
  deniedActions: number;
  /** Runs sautés ou interrompus. */
  skippedRuns: number;
  /** Tri : jour croissant (`AAAA-MM-JJ`, heure locale). */
  daily: { day: string; success: number; error: number; skipped: number }[];
  tasks: (ScheduledTask & { periodRuns: number; periodSuccessRate?: number })[];
}

// --- Calcul des exécutions (fonctions pures, heure locale)

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;

function parseTime(time: string): { hours: number; minutes: number } {
  const match = TIME_PATTERN.exec(time);
  if (!match) throw new RangeError(`Heure invalide : ${time}`);
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * Instant local `jour à HH:MM`. Une heure qui n'existe pas (passage à l'heure
 * d'été) devient la première minute valide qui suit ; une heure ambiguë (passage
 * à l'heure d'hiver) prend sa première occurrence (règle d'ECMAScript).
 */
function localAt(year: number, monthIndex: number, day: number, hours: number, minutes: number) {
  const wanted = hours * 60 + minutes;
  for (let shift = 0; shift <= 24 * 60; shift += 1) {
    const date = new Date(year, monthIndex, day, 0, wanted + shift);
    if (date.getDate() !== day) break;
    if (date.getHours() * 60 + date.getMinutes() === wanted + shift) return date;
  }
  // Inatteignable avec les fuseaux réels (aucun trou ne couvre le reste de la journée).
  return new Date(year, monthIndex, day, hours, minutes);
}

function isoWeekday(date: Date): IsoWeekday {
  return (((date.getDay() + 6) % 7) + 1) as IsoWeekday;
}

/** Premier candidat strictement postérieur à `after`, en avançant jour par jour. */
function nextOnDays(
  after: Date,
  time: string,
  maxDays: number,
  accept: (year: number, monthIndex: number, day: number) => boolean,
): Date {
  const { hours, minutes } = parseTime(time);
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
    if (!accept(day.getFullYear(), day.getMonth(), day.getDate())) continue;
    const candidate = localAt(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new RangeError('Aucune exécution trouvée pour cette récurrence.');
}

/**
 * Prochaine exécution strictement après `after`.
 *
 * Pour `interval`, `after` est l'ancre : le dernier run (ou la création de la
 * tâche). Le résultat est `after + every × unit`, sans alignement sur l'horloge.
 * Si ce résultat est déjà passé, c'est au scheduler de rattraper puis de
 * recalculer depuis maintenant (ADR-002 D1).
 *
 * Lève une `RangeError` sur une récurrence invalide : appeler d'abord
 * {@link validateSchedule}.
 */
export function nextRunAt(schedule: Schedule, after: Date): Date {
  const invalid = validateSchedule(schedule);
  if (invalid !== undefined) throw new RangeError(invalid);
  switch (schedule.kind) {
    case 'interval': {
      const unitMs = schedule.unit === 'hours' ? 60 * MINUTE_MS : MINUTE_MS;
      return new Date(after.getTime() + schedule.every * unitMs);
    }
    case 'daily':
      return nextOnDays(after, schedule.time, 2, () => true);
    case 'weekly': {
      const days = new Set<number>(schedule.days);
      return nextOnDays(after, schedule.time, 8, (y, m, d) =>
        days.has(isoWeekday(new Date(y, m, d))),
      );
    }
    case 'monthly': {
      const { hours, minutes } = parseTime(schedule.time);
      for (let offset = 0; offset <= 2; offset += 1) {
        const month = new Date(after.getFullYear(), after.getMonth() + offset, 1);
        const y = month.getFullYear();
        const m = month.getMonth();
        const candidate = localAt(y, m, Math.min(schedule.day, daysInMonth(y, m)), hours, minutes);
        if (candidate.getTime() > after.getTime()) return candidate;
      }
      break;
    }
    case 'yearly': {
      const { hours, minutes } = parseTime(schedule.time);
      const m = schedule.month - 1;
      for (let offset = 0; offset <= 1; offset += 1) {
        const y = after.getFullYear() + offset;
        const candidate = localAt(y, m, Math.min(schedule.day, daysInMonth(y, m)), hours, minutes);
        if (candidate.getTime() > after.getTime()) return candidate;
      }
      break;
    }
  }
  throw new RangeError('Aucune exécution trouvée pour cette récurrence.');
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Vérifie une récurrence. Renvoie un message en français à afficher, ou
 * `undefined` si elle est valide. Défensive : la valeur peut venir de l'IPC.
 */
export function validateSchedule(schedule: Schedule): string | undefined {
  const value = schedule as Partial<Record<string, unknown>> | null;
  if (typeof value !== 'object' || value === null) return 'Récurrence manquante.';
  const timeInvalid = 'Heure invalide : utilisez le format HH:MM, par exemple 08:00.';
  switch (value['kind']) {
    case 'interval': {
      const { every, unit } = value;
      if (unit !== 'minutes' && unit !== 'hours') return 'Choisissez des minutes ou des heures.';
      if (!isInteger(every, 1, Number.MAX_SAFE_INTEGER)) {
        return 'L’intervalle doit être un nombre entier positif.';
      }
      if ((unit === 'hours' ? every * 60 : every) < MIN_INTERVAL_MINUTES) {
        return `L’intervalle doit être d’au moins ${String(MIN_INTERVAL_MINUTES)} minutes.`;
      }
      return undefined;
    }
    case 'daily':
      return typeof value['time'] === 'string' && TIME_PATTERN.test(value['time'])
        ? undefined
        : timeInvalid;
    case 'weekly': {
      const { days, time } = value;
      if (!Array.isArray(days) || days.length === 0) {
        return 'Choisissez au moins un jour de la semaine.';
      }
      if (!days.every((d) => isInteger(d, 1, 7))) return 'Jour de la semaine invalide.';
      return typeof time === 'string' && TIME_PATTERN.test(time) ? undefined : timeInvalid;
    }
    case 'monthly': {
      if (!isInteger(value['day'], 1, 31))
        return 'Le jour du mois doit être compris entre 1 et 31.';
      const time = value['time'];
      return typeof time === 'string' && TIME_PATTERN.test(time) ? undefined : timeInvalid;
    }
    case 'yearly': {
      const { month, day, time } = value;
      if (!isInteger(month, 1, 12)) return 'Mois invalide.';
      // Année bissextile de référence : le 29 février est permis.
      if (!isInteger(day, 1, daysInMonth(2024, month - 1)))
        return 'Ce jour n’existe pas dans ce mois.';
      return typeof time === 'string' && TIME_PATTERN.test(time) ? undefined : timeInvalid;
    }
    default:
      return 'Type de récurrence inconnu.';
  }
}

const WEEKDAYS: Record<IsoWeekday, [singular: string, plural: string]> = {
  1: ['lundi', 'lundis'],
  2: ['mardi', 'mardis'],
  3: ['mercredi', 'mercredis'],
  4: ['jeudi', 'jeudis'],
  5: ['vendredi', 'vendredis'],
  6: ['samedi', 'samedis'],
  7: ['dimanche', 'dimanches'],
};

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

function joinFrench(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items.at(-1) ?? ''}`;
}

function dayOfMonth(day: number): string {
  return day === 1 ? '1er' : String(day);
}

/**
 * Libellé français d'une récurrence, ex. « Tous les lundis et jeudis à 08:00 ».
 * Suppose une récurrence valide ({@link validateSchedule}).
 */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'interval': {
      const { every, unit } = schedule;
      if (unit === 'hours')
        return every === 1 ? 'Toutes les heures' : `Toutes les ${String(every)} heures`;
      return `Toutes les ${String(every)} minutes`;
    }
    case 'daily':
      return `Chaque jour à ${schedule.time}`;
    case 'weekly': {
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);
      if (days.length === 7) return `Chaque jour à ${schedule.time}`;
      if (days.join() === '1,2,3,4,5') return `Du lundi au vendredi à ${schedule.time}`;
      if (days.join() === '6,7') return `Le week-end à ${schedule.time}`;
      if (days.length === 1)
        return `Chaque ${WEEKDAYS[days[0] as IsoWeekday][0]} à ${schedule.time}`;
      return `Tous les ${joinFrench(days.map((d) => WEEKDAYS[d][1]))} à ${schedule.time}`;
    }
    case 'monthly': {
      const last = schedule.day > 28 ? ' (ou le dernier jour du mois)' : '';
      return `Le ${dayOfMonth(schedule.day)} de chaque mois${last} à ${schedule.time}`;
    }
    case 'yearly': {
      const date = `${dayOfMonth(schedule.day)} ${MONTHS[schedule.month - 1] ?? ''}`;
      const leap = schedule.month === 2 && schedule.day === 29 ? ' (le 28 les autres années)' : '';
      return `Chaque année le ${date}${leap} à ${schedule.time}`;
    }
  }
}
