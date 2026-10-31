/**
 * Tâches planifiées et historique de leurs runs (ADR-002 D6).
 *
 * Deux implémentations : SQLite (`atelier.db`, migration n° 4) et mémoire
 * (tests, repli si la base est indisponible). Les agrégats du tableau de bord
 * sont calculés par une seule fonction pure, {@link summarizeDashboard}, pour
 * que les deux versions donnent exactement les mêmes chiffres.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  DeniedAction,
  Schedule,
  ScheduleDashboard,
  ScheduledPermissions,
  ScheduledRun,
  ScheduledRunSkipReason,
  ScheduledRunStatus,
  ScheduledRunTrigger,
  ScheduledTask,
  SerializedAtelierError,
  UsagePeriod,
} from '@atelier/shared';
import { localDay, periodStartDay } from '../../common/usage-days.js';

/** Statuts d'un run qui n'est pas terminé. */
export const OPEN_RUN_STATUSES: readonly ScheduledRunStatus[] = ['queued', 'running'];

/** Tâche telle qu'enregistrée (sans `lastRun`, calculé à la lecture). */
export type StoredTask = Omit<ScheduledTask, 'lastRun'>;

/** Run tel qu'enregistré : `turnId` pour la jointure avec `usage_turns`. */
export interface StoredRun extends Omit<ScheduledRun, 'taskName' | 'durationMs' | 'totalTokens'> {
  turnId?: string;
}

/** Champs modifiables d'un run au fil de son exécution. */
export type RunPatch = Partial<
  Pick<
    StoredRun,
    | 'sessionId'
    | 'turnId'
    | 'status'
    | 'skipReason'
    | 'startedAt'
    | 'finishedAt'
    | 'summary'
    | 'files'
    | 'denied'
    | 'error'
  >
>;

export interface RunQuery {
  taskId?: string;
  /** Runs prévus strictement avant cette date ISO (pagination). */
  before?: string;
  /** Défaut 50. */
  limit?: number;
}

export interface ScheduleStore {
  listTasks(): ScheduledTask[];
  getTask(id: string): ScheduledTask | undefined;
  /** Ajoute ou remplace la tâche. */
  saveTask(task: StoredTask): void;
  /** Supprime la tâche et ses runs (les conversations restent). */
  deleteTask(id: string): void;
  createRun(run: StoredRun): void;
  updateRun(id: string, patch: RunPatch): ScheduledRun;
  getRun(id: string): ScheduledRun | undefined;
  /** Runs du plus récent au plus ancien (`scheduled_for`). */
  runs(query?: RunQuery): ScheduledRun[];
  /** Runs `queued` ou `running` (d'une tâche, ou de toutes). */
  openRuns(taskId?: string): ScheduledRun[];
  /** Au démarrage : les runs restés ouverts (app tuée) passent en `interrupted`. */
  interruptOpenRuns(now: Date): ScheduledRun[];
  dashboard(period: UsagePeriod, now?: Date): ScheduleDashboard;
  /**
   * Supprime les runs prévus avant `cutoff`, et leur conversation sauf si
   * l'utilisateur y a écrit (plus de 2 messages). Renvoie le nombre de runs supprimés.
   */
  purge(cutoff: Date): number;
}

/** Erreur « run introuvable » (code commun avec les tâches). */
export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run introuvable : ${runId}`);
  }
}

/** Durée d'un run terminé (ou en cours jusqu'à `now`). */
function durationOf(run: Pick<StoredRun, 'startedAt' | 'finishedAt'>): number | undefined {
  if (!run.startedAt || !run.finishedAt) return undefined;
  return Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
}

/** Vue publique d'un run enregistré. */
export function toScheduledRun(
  run: StoredRun,
  taskName: string,
  totalTokens: number | undefined,
): ScheduledRun {
  const { turnId: _turnId, ...rest } = run;
  const durationMs = durationOf(run);
  return {
    ...rest,
    taskName,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/** Statuts comptés dans le taux de réussite (ni sautés, ni interrompus, ni en cours). */
const RATED: readonly ScheduledRunStatus[] = ['success', 'error', 'timeout', 'aborted'];

function successRate(runs: readonly ScheduledRun[]): number | undefined {
  const rated = runs.filter((r) => RATED.includes(r.status));
  if (rated.length === 0) return undefined;
  return rated.filter((r) => r.status === 'success').length / rated.length;
}

/**
 * Agrégats du tableau de bord (D7), à partir des tâches et de TOUS les runs
 * connus : la période est filtrée ici, sur le jour local de `scheduledFor`.
 */
export function summarizeDashboard(
  tasks: readonly ScheduledTask[],
  allRuns: readonly ScheduledRun[],
  period: UsagePeriod,
  now: Date,
): ScheduleDashboard {
  const start = periodStartDay(period, now);
  const runs = allRuns.filter(
    (r) => start === undefined || localDay(new Date(r.scheduledFor)) >= start,
  );
  const active = tasks.filter((t) => t.enabled);
  const next = active
    .map((t) => t.nextRunAt)
    .filter((at): at is string => at !== undefined)
    .sort()[0];
  const timed = runs.map((r) => r.durationMs).filter((d): d is number => d !== undefined);
  const rate = successRate(runs);

  const byDay = new Map<string, { day: string; success: number; error: number; skipped: number }>();
  for (const run of runs) {
    const day = localDay(new Date(run.scheduledFor));
    const entry = byDay.get(day) ?? { day, success: 0, error: 0, skipped: 0 };
    if (run.status === 'success') entry.success += 1;
    else if (run.status === 'skipped' || run.status === 'interrupted') entry.skipped += 1;
    else if (run.status === 'error' || run.status === 'timeout' || run.status === 'aborted') {
      entry.error += 1;
    } else continue;
    byDay.set(day, entry);
  }

  return {
    period,
    activeTasks: active.length,
    ...(next !== undefined ? { nextRunAt: next } : {}),
    runs: runs.length,
    ...(rate !== undefined ? { successRate: rate } : {}),
    ...(timed.length > 0
      ? { avgDurationMs: timed.reduce((sum, d) => sum + d, 0) / timed.length }
      : {}),
    totalTokens: runs.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0),
    deniedActions: runs.reduce((sum, r) => sum + r.denied.length, 0),
    skippedRuns: runs.filter((r) => r.status === 'skipped' || r.status === 'interrupted').length,
    daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    tasks: tasks.map((task) => {
      const own = runs.filter((r) => r.taskId === task.id);
      const ownRate = successRate(own);
      return {
        ...task,
        periodRuns: own.length,
        ...(ownRate !== undefined ? { periodSuccessRate: ownRate } : {}),
      };
    }),
  };
}

function lastRunOf(runs: readonly ScheduledRun[]): ScheduledTask['lastRun'] {
  const last = runs[0];
  return last ? { id: last.id, status: last.status, scheduledFor: last.scheduledFor } : undefined;
}

function withLastRun(task: StoredTask, last: ScheduledTask['lastRun']): ScheduledTask {
  return last ? { ...task, lastRun: last } : { ...task };
}

/** Tri des runs : le plus récent d'abord. */
function newestFirst(a: Pick<StoredRun, 'scheduledFor' | 'id'>, b: typeof a): number {
  return b.scheduledFor.localeCompare(a.scheduledFor) || b.id.localeCompare(a.id);
}

export class InMemoryScheduleStore implements ScheduleStore {
  readonly #tasks = new Map<string, StoredTask>();
  readonly #runs = new Map<string, StoredRun>();
  readonly #tokens: (turnId: string) => number | undefined;

  /** @param tokens - Tokens d'un tour (jointure `usage_turns` de la version SQLite). */
  constructor(options: { tokens?: (turnId: string) => number | undefined } = {}) {
    this.#tokens = options.tokens ?? (() => undefined);
  }

  listTasks(): ScheduledTask[] {
    return [...this.#tasks.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((task) => withLastRun(task, lastRunOf(this.runs({ taskId: task.id, limit: 1 }))));
  }

  getTask(id: string): ScheduledTask | undefined {
    const task = this.#tasks.get(id);
    return task ? withLastRun(task, lastRunOf(this.runs({ taskId: id, limit: 1 }))) : undefined;
  }

  saveTask(task: StoredTask): void {
    this.#tasks.set(task.id, { ...task });
  }

  deleteTask(id: string): void {
    this.#tasks.delete(id);
    for (const [runId, run] of this.#runs) if (run.taskId === id) this.#runs.delete(runId);
  }

  createRun(run: StoredRun): void {
    this.#runs.set(run.id, { ...run });
  }

  updateRun(id: string, patch: RunPatch): ScheduledRun {
    const current = this.#runs.get(id);
    if (!current) throw new RunNotFoundError(id);
    const next = { ...current, ...patch };
    this.#runs.set(id, next);
    return this.#view(next);
  }

  getRun(id: string): ScheduledRun | undefined {
    const run = this.#runs.get(id);
    return run ? this.#view(run) : undefined;
  }

  runs(query: RunQuery = {}): ScheduledRun[] {
    const { before } = query;
    return [...this.#runs.values()]
      .filter((r) => query.taskId === undefined || r.taskId === query.taskId)
      .filter((r) => before === undefined || r.scheduledFor < before)
      .sort(newestFirst)
      .slice(0, query.limit ?? 50)
      .map((r) => this.#view(r));
  }

  openRuns(taskId?: string): ScheduledRun[] {
    return [...this.#runs.values()]
      .filter((r) => OPEN_RUN_STATUSES.includes(r.status))
      .filter((r) => taskId === undefined || r.taskId === taskId)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
      .map((r) => this.#view(r));
  }

  interruptOpenRuns(now: Date): ScheduledRun[] {
    return this.openRuns().map((run) =>
      this.updateRun(run.id, { status: 'interrupted', finishedAt: now.toISOString() }),
    );
  }

  dashboard(period: UsagePeriod, now = new Date()): ScheduleDashboard {
    const all = [...this.#runs.values()].sort(newestFirst).map((r) => this.#view(r));
    return summarizeDashboard(this.listTasks(), all, period, now);
  }

  purge(cutoff: Date): number {
    const limit = cutoff.toISOString();
    let removed = 0;
    for (const [id, run] of this.#runs) {
      if (run.scheduledFor >= limit) continue;
      this.#runs.delete(id);
      removed += 1;
    }
    return removed;
  }

  #view(run: StoredRun): ScheduledRun {
    const name = this.#tasks.get(run.taskId)?.name ?? '';
    return toScheduledRun(run, name, run.turnId ? this.#tokens(run.turnId) : undefined);
  }
}

// --- SQLite

interface TaskRow {
  id: string;
  name: string;
  prompt: string;
  workspace: string;
  model: string | null;
  schedule: string;
  permissions: string;
  max_duration_min: number;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  project_id: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  session_id: string | null;
  turn_id: string | null;
  trigger: string;
  status: string;
  skip_reason: string | null;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  files: string | null;
  denied: string | null;
  error: string | null;
  task_name: string | null;
  total_tokens: number | null;
}

/** JSON relu ; une valeur corrompue donne le repli plutôt qu'un crash. */
function parseJson<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toTask(row: TaskRow): StoredTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    workspace: row.workspace,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    schedule: parseJson<Schedule>(row.schedule, { kind: 'daily', time: '08:00' }),
    permissions: parseJson<ScheduledPermissions>(row.permissions, {
      fileWrite: false,
      commands: false,
      webDomains: [],
      mcpTools: [],
    }),
    maxDurationMinutes: row.max_duration_min,
    enabled: row.enabled === 1,
    ...(row.next_run_at !== null ? { nextRunAt: row.next_run_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredRun(row: RunRow): StoredRun {
  const error = parseJson<SerializedAtelierError | null>(row.error, null);
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    trigger: row.trigger as ScheduledRunTrigger,
    status: row.status as ScheduledRunStatus,
    ...(row.skip_reason !== null ? { skipReason: row.skip_reason as ScheduledRunSkipReason } : {}),
    scheduledFor: row.scheduled_for,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.summary !== null ? { summary: row.summary } : {}),
    files: parseJson<string[]>(row.files, []),
    denied: parseJson<DeniedAction[]>(row.denied, []),
    ...(error ? { error } : {}),
  };
}

function toRun(row: RunRow): ScheduledRun {
  return toScheduledRun(toStoredRun(row), row.task_name ?? '', row.total_tokens ?? undefined);
}

/** Runs avec le nom de leur tâche et les tokens de leur tour. */
const RUN_SELECT = `
  SELECT r.*, t.name AS task_name,
         (SELECT u.input_tokens + u.output_tokens FROM usage_turns u WHERE u.turn_id = r.turn_id)
           AS total_tokens
  FROM scheduled_runs r
  LEFT JOIN scheduled_tasks t ON t.id = r.task_id`;

const OPEN_SQL = OPEN_RUN_STATUSES.map((s) => `'${s}'`).join(', ');

export class SqliteScheduleStore implements ScheduleStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  listTasks(): ScheduledTask[] {
    const rows = this.#db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at, rowid')
      .all() as unknown as TaskRow[];
    return rows.map((row) => withLastRun(toTask(row), this.#lastRun(row.id)));
  }

  getTask(id: string): ScheduledTask | undefined {
    const row = this.#db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
      TaskRow | undefined;
    return row ? withLastRun(toTask(row), this.#lastRun(id)) : undefined;
  }

  saveTask(task: StoredTask): void {
    this.#db
      .prepare(
        `INSERT INTO scheduled_tasks (id, name, prompt, workspace, model, schedule, permissions,
           max_duration_min, enabled, next_run_at, created_at, updated_at, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, prompt = excluded.prompt, workspace = excluded.workspace,
           project_id = excluded.project_id,
           model = excluded.model, schedule = excluded.schedule,
           permissions = excluded.permissions, max_duration_min = excluded.max_duration_min,
           enabled = excluded.enabled, next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        task.id,
        task.name,
        task.prompt,
        task.workspace,
        task.model ?? null,
        JSON.stringify(task.schedule),
        JSON.stringify(task.permissions),
        task.maxDurationMinutes,
        task.enabled ? 1 : 0,
        task.nextRunAt ?? null,
        task.createdAt,
        task.updatedAt,
        task.projectId ?? null,
      );
  }

  deleteTask(id: string): void {
    // Runs supprimés en cascade ; leurs conversations restent consultables.
    this.#db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  }

  createRun(run: StoredRun): void {
    this.#db
      .prepare(
        `INSERT INTO scheduled_runs (id, task_id, session_id, turn_id, trigger, status,
           skip_reason, scheduled_for, started_at, finished_at, summary, files, denied, error)
         VALUES (?, ?, (SELECT id FROM sessions WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.sessionId ?? null,
        run.turnId ?? null,
        run.trigger,
        run.status,
        run.skipReason ?? null,
        run.scheduledFor,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.summary ?? null,
        JSON.stringify(run.files),
        JSON.stringify(run.denied),
        run.error ? JSON.stringify(run.error) : null,
      );
  }

  updateRun(id: string, patch: RunPatch): ScheduledRun {
    const row = this.#db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id) as
      RunRow | undefined;
    if (!row) throw new RunNotFoundError(id);
    const next: StoredRun = {
      ...toStoredRun({ ...row, task_name: null, total_tokens: null }),
      ...patch,
    };
    this.#db
      .prepare(
        `UPDATE scheduled_runs SET session_id = (SELECT id FROM sessions WHERE id = ?),
           turn_id = ?, status = ?, skip_reason = ?, started_at = ?, finished_at = ?,
           summary = ?, files = ?, denied = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        next.sessionId ?? null,
        next.turnId ?? null,
        next.status,
        next.skipReason ?? null,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.summary ?? null,
        JSON.stringify(next.files),
        JSON.stringify(next.denied),
        next.error ? JSON.stringify(next.error) : null,
        id,
      );
    const updated = this.getRun(id);
    if (!updated) throw new RunNotFoundError(id);
    return updated;
  }

  getRun(id: string): ScheduledRun | undefined {
    const row = this.#db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  runs(query: RunQuery = {}): ScheduledRun[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (query.taskId !== undefined) {
      conditions.push('r.task_id = ?');
      params.push(query.taskId);
    }
    if (query.before !== undefined) {
      conditions.push('r.scheduled_for < ?');
      params.push(query.before);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`${RUN_SELECT} ${where} ORDER BY r.scheduled_for DESC, r.id DESC LIMIT ?`)
      .all(...params, query.limit ?? 50) as unknown as RunRow[];
    return rows.map(toRun);
  }

  openRuns(taskId?: string): ScheduledRun[] {
    const rows = (taskId === undefined
      ? this.#db
          .prepare(`${RUN_SELECT} WHERE r.status IN (${OPEN_SQL}) ORDER BY r.scheduled_for`)
          .all()
      : this.#db
          .prepare(
            `${RUN_SELECT} WHERE r.status IN (${OPEN_SQL}) AND r.task_id = ? ORDER BY r.scheduled_for`,
          )
          .all(taskId)) as unknown as RunRow[];
    return rows.map(toRun);
  }

  interruptOpenRuns(now: Date): ScheduledRun[] {
    const open = this.openRuns();
    this.#db
      .prepare(
        `UPDATE scheduled_runs SET status = 'interrupted', finished_at = ? WHERE status IN (${OPEN_SQL})`,
      )
      .run(now.toISOString());
    return open
      .map((run) => this.getRun(run.id))
      .filter((run): run is ScheduledRun => run !== undefined);
  }

  dashboard(period: UsagePeriod, now = new Date()): ScheduleDashboard {
    // Volume borné par la purge à 90 jours : l'agrégation se fait en TypeScript,
    // avec la même fonction que la version en mémoire.
    const start = periodStartDay(period, now);
    // Marge d'un jour : `scheduled_for` est en UTC, la période en jours locaux.
    const since =
      start === undefined
        ? undefined
        : new Date(new Date(`${start}T00:00:00`).getTime() - 86_400_000).toISOString();
    const rows = (since === undefined
      ? this.#db.prepare(`${RUN_SELECT} ORDER BY r.scheduled_for DESC`).all()
      : this.#db
          .prepare(`${RUN_SELECT} WHERE r.scheduled_for >= ? ORDER BY r.scheduled_for DESC`)
          .all(since)) as unknown as RunRow[];
    return summarizeDashboard(this.listTasks(), rows.map(toRun), period, now);
  }

  purge(cutoff: Date): number {
    const limit = cutoff.toISOString();
    this.#db.exec('BEGIN');
    try {
      // Conversations des vieux runs, sauf celles où l'utilisateur a répondu.
      this.#db
        .prepare(
          `DELETE FROM sessions WHERE id IN (
             SELECT r.session_id FROM scheduled_runs r
             WHERE r.scheduled_for < ? AND r.session_id IS NOT NULL
               AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = r.session_id) <= 2)`,
        )
        .run(limit);
      const result = this.#db
        .prepare('DELETE FROM scheduled_runs WHERE scheduled_for < ?')
        .run(limit);
      this.#db.exec('COMMIT');
      return Number(result.changes);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #lastRun(taskId: string): ScheduledTask['lastRun'] {
    const row = this.#db
      .prepare(
        `SELECT id, status, scheduled_for FROM scheduled_runs WHERE task_id = ?
         ORDER BY scheduled_for DESC, id DESC LIMIT 1`,
      )
      .get(taskId) as { id: string; status: string; scheduled_for: string } | undefined;
    return row
      ? { id: row.id, status: row.status as ScheduledRunStatus, scheduledFor: row.scheduled_for }
      : undefined;
  }
}
