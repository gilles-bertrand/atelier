/**
 * Planificateur des prompts planifiés (ADR-002 D1, D5), dans le process main.
 *
 * - Un seul minuteur, armé sur la plus proche `nextRunAt` des tâches actives et
 *   plafonné à une heure (dérives d'horloge, changements d'heure).
 * - L'état vit dans le `ScheduleStore` : rien n'est gardé en mémoire seulement,
 *   sauf la file des runs en attente de cette session de l'app.
 * - Rattrapage (`catchUp`) au démarrage et au réveil : une tâche en retard
 *   s'exécute UNE fois (`catch_up`), quel que soit le nombre d'occurrences
 *   manquées, puis repart de maintenant.
 * - Un seul run à la fois (file FIFO) ; une tâche qui a déjà un run en cours ou
 *   en file voit l'occurrence sautée (`skipped`, motif `overlap`).
 */
import { randomUUID } from 'node:crypto';
import {
  AtelierError,
  DEFAULT_MAX_DURATION_MINUTES,
  MAX_MAX_DURATION_MINUTES,
  MIN_MAX_DURATION_MINUTES,
  nextRunAt as sharedNextRunAt,
  validateSchedule as sharedValidateSchedule,
  type Schedule,
  type ScheduledRun,
  type ScheduledRunTrigger,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduleDashboard,
  type UsagePeriod,
} from '@atelier/shared';
import { systemClock, type Clock } from './clock.js';
import type { RunPatch, RunQuery, ScheduleStore, StoredTask } from './schedule-store.js';
import type { RunRequest } from './scheduled-runner.js';

/** Plafond du minuteur (D1). */
export const MAX_TIMER_MS = 60 * 60_000;
/** Ancienneté au-delà de laquelle les runs sont purgés (D6). */
export const RUN_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export interface TaskSchedulerOptions {
  store: ScheduleStore;
  /** Exécute un run en file jusqu'au bout et renvoie son état final. */
  execute: (request: RunRequest) => Promise<RunPatch>;
  /** Prochaine exécution (défaut : `nextRunAt` de `@atelier/shared`). */
  nextRunAt?: (schedule: Schedule, after: Date) => Date;
  /** Message français si la récurrence est invalide (défaut : `validateSchedule` de shared). */
  validateSchedule?: (schedule: Schedule) => string | undefined;
  clock?: Clock;
  /** Tâche ou run modifié (`schedule:changed`). */
  onChange?: (change: { taskId: string; run?: ScheduledRun }) => void;
  /** Run terminé (hors `skipped`) : notification macOS. */
  onFinished?: (task: ScheduledTask, run: ScheduledRun) => void;
  log?: (message: string, data?: unknown) => void;
  newId?: () => string;
}

interface Queued {
  runId: string;
  taskId: string;
}

/** Tâche invalide : le renderer affiche le message tel quel, sous le champ `field`. */
function invalid(field: string, message: string): AtelierError {
  return new AtelierError('schedule/invalid', message, { details: { field } });
}

function notFound(id: string): AtelierError {
  return new AtelierError('schedule/not_found', 'Tâche planifiée introuvable.', {
    details: { id },
  });
}

export class TaskScheduler {
  readonly #o: TaskSchedulerOptions;
  readonly #clock: Clock;
  readonly #queue: Queued[] = [];
  #current: { runId: string; taskId: string; controller: AbortController } | undefined;
  #cancelTimer: (() => void) | undefined;
  #lastPurge = 0;
  #started = false;

  constructor(options: TaskSchedulerOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Démarrage de l'app : les runs restés ouverts passent en `interrupted`, les
   * vieux runs sont purgés, puis rattrapage et armement du minuteur.
   */
  start(): void {
    this.#started = true;
    for (const run of this.#o.store.interruptOpenRuns(this.#clock.now())) {
      this.#o.onChange?.({ taskId: run.taskId, run });
    }
    this.#purge();
    this.catchUp();
  }

  /** Arrête le minuteur (fermeture de l'app) ; le run en cours est annulé. */
  stop(): void {
    this.#started = false;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#current?.controller.abort();
  }

  /** Rattrapage (démarrage, réveil, déverrouillage) : une exécution par tâche en retard. */
  catchUp(): void {
    this.#dispatchDue('catch_up');
  }

  listTasks(): ScheduledTask[] {
    return this.#o.store.listTasks();
  }

  dashboard(period: UsagePeriod): ScheduleDashboard {
    return this.#o.store.dashboard(period, this.#clock.now());
  }

  runs(query?: RunQuery): ScheduledRun[] {
    return this.#o.store.runs(query);
  }

  /** Crée (`id` absent) ou modifie une tâche ; recalcule sa prochaine exécution. */
  saveTask(input: ScheduledTaskInput, id?: string): ScheduledTask {
    const existing = id === undefined ? undefined : this.#o.store.getTask(id);
    if (id !== undefined && !existing) throw notFound(id);
    const task = this.#validated(input);
    const now = this.#clock.now();
    const stored: StoredTask = {
      ...task,
      id: existing?.id ?? this.#id(),
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    // Récurrence ou activation changée : la prochaine exécution repart de maintenant.
    // Sinon (renommage…), elle est gardée : la cadence d'un intervalle ne glisse pas.
    const unchanged =
      existing !== undefined &&
      existing.enabled === stored.enabled &&
      JSON.stringify(existing.schedule) === JSON.stringify(stored.schedule);
    const next = !stored.enabled
      ? undefined
      : unchanged && existing.nextRunAt !== undefined
        ? existing.nextRunAt
        : this.#nextRunAt(stored.schedule, now).toISOString();
    if (next !== undefined) stored.nextRunAt = next;
    else delete stored.nextRunAt;
    this.#o.store.saveTask(stored);
    this.#arm();
    return this.#task(stored.id);
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask {
    const task = this.#o.store.getTask(id);
    if (!task) throw notFound(id);
    const {
      lastRun: _lastRun,
      nextRunAt: _nextRunAt,
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...input
    } = task;
    return this.saveTask({ ...input, enabled }, id);
  }

  /** Supprime la tâche et ses runs ; un run en cours est arrêté. */
  async deleteTask(id: string): Promise<void> {
    if (!this.#o.store.getTask(id)) throw notFound(id);
    for (const run of this.#o.store.openRuns(id)) await this.stopRun(run.id);
    this.#o.store.deleteTask(id);
    this.#arm();
    this.#o.onChange?.({ taskId: id });
  }

  /** « Exécuter maintenant » : run en file, avec la vraie politique de la tâche. */
  runNow(id: string): ScheduledRun {
    const task = this.#o.store.getTask(id);
    if (!task) throw notFound(id);
    return this.#enqueue(task, 'manual', this.#clock.now().toISOString());
  }

  /** Arrête un run en cours, ou le retire de la file. */
  async stopRun(runId: string): Promise<void> {
    if (this.#current?.runId === runId) {
      this.#current.controller.abort();
      return;
    }
    const index = this.#queue.findIndex((q) => q.runId === runId);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#update(runId, { status: 'aborted', finishedAt: this.#clock.now().toISOString() });
    await Promise.resolve();
  }

  /** Run en cours (le tableau de bord et le Composer l'affichent). */
  currentRunId(): string | undefined {
    return this.#current?.runId;
  }

  // --- Minuteur

  #arm(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    if (!this.#started) return;
    const next = this.#o.store
      .listTasks()
      .filter((t) => t.enabled && t.nextRunAt !== undefined)
      .map((t) => Date.parse(t.nextRunAt ?? ''))
      .sort((a, b) => a - b)[0];
    // Sans tâche active, un réveil par heure suffit à la purge quotidienne.
    const now = this.#clock.now().getTime();
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, (next ?? Infinity) - now));
    this.#cancelTimer = this.#clock.setTimer(() => {
      this.#cancelTimer = undefined;
      this.#purge();
      this.#dispatchDue('schedule');
    }, delay);
  }

  /** Met en file chaque tâche active arrivée à échéance, puis réarme. */
  #dispatchDue(trigger: ScheduledRunTrigger): void {
    const now = this.#clock.now();
    for (const task of this.#o.store.listTasks()) {
      if (!task.enabled || task.nextRunAt === undefined) continue;
      if (Date.parse(task.nextRunAt) > now.getTime()) continue;
      // Jamais de série rejouée : la suivante repart de maintenant (D1).
      const { lastRun: _lastRun, ...stored } = task;
      this.#o.store.saveTask({
        ...stored,
        nextRunAt: this.#nextRunAt(task.schedule, now).toISOString(),
      });
      this.#enqueue(task, trigger, task.nextRunAt);
    }
    this.#arm();
  }

  // --- File

  #enqueue(task: ScheduledTask, trigger: ScheduledRunTrigger, scheduledFor: string): ScheduledRun {
    const runId = this.#id();
    // Pas de chevauchement : la tâche a déjà un run en cours ou en file.
    const overlap = this.#o.store.openRuns(task.id).length > 0;
    this.#o.store.createRun({
      id: runId,
      taskId: task.id,
      trigger,
      status: overlap ? 'skipped' : 'queued',
      ...(overlap
        ? { skipReason: 'overlap' as const, finishedAt: this.#clock.now().toISOString() }
        : {}),
      scheduledFor,
      files: [],
      denied: [],
    });
    const run = this.#run(runId);
    this.#o.onChange?.({ taskId: task.id, run });
    if (!overlap) {
      this.#queue.push({ runId, taskId: task.id });
      void this.#pump();
    }
    return run;
  }

  async #pump(): Promise<void> {
    if (this.#current) return;
    const next = this.#queue.shift();
    if (!next) return;
    const task = this.#o.store.getTask(next.taskId);
    if (!task) {
      void this.#pump();
      return;
    }
    const controller = new AbortController();
    this.#current = { ...next, controller };
    try {
      const final = await this.#o.execute({
        runId: next.runId,
        task,
        signal: controller.signal,
        update: (patch) => {
          this.#update(next.runId, patch);
        },
      });
      const run = this.#update(next.runId, final);
      if (run && run.status !== 'skipped') this.#o.onFinished?.(task, run);
    } catch (error) {
      // `execute` ne rejette pas ; garde-fou pour ne jamais bloquer la file.
      this.#o.log?.('run planifié en échec', error);
      this.#update(next.runId, { status: 'error', finishedAt: this.#clock.now().toISOString() });
    } finally {
      this.#current = undefined;
      void this.#pump();
    }
  }

  // --- Utilitaires

  #validated(input: ScheduledTaskInput): Omit<StoredTask, 'id' | 'createdAt' | 'updatedAt'> {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const workspace = input.workspace.trim();
    if (name === '') throw invalid('name', 'Donnez un nom à la tâche.');
    if (prompt === '') throw invalid('prompt', 'Écrivez la demande à exécuter.');
    if (workspace === '') throw invalid('workspace', 'Choisissez le dossier de la tâche.');
    const problem = (this.#o.validateSchedule ?? sharedValidateSchedule)(input.schedule);
    if (problem !== undefined) throw invalid('schedule', problem);
    const max = input.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES;
    if (
      !Number.isInteger(max) ||
      max < MIN_MAX_DURATION_MINUTES ||
      max > MAX_MAX_DURATION_MINUTES
    ) {
      throw invalid(
        'maxDurationMinutes',
        `La durée maximale doit être comprise entre ${String(MIN_MAX_DURATION_MINUTES)} et ${String(MAX_MAX_DURATION_MINUTES)} minutes.`,
      );
    }
    const model = input.model?.trim();
    const projectId = input.projectId?.trim();
    return {
      name,
      prompt,
      workspace,
      ...(projectId ? { projectId } : {}),
      ...(model ? { model } : {}),
      schedule: input.schedule,
      permissions: input.permissions,
      maxDurationMinutes: max,
      enabled: input.enabled ?? true,
    };
  }

  #purge(): void {
    const now = this.#clock.now().getTime();
    if (now - this.#lastPurge < DAY_MS) return;
    this.#lastPurge = now;
    try {
      const removed = this.#o.store.purge(new Date(now - RUN_RETENTION_DAYS * DAY_MS));
      if (removed > 0) this.#o.log?.('runs planifiés purgés', { removed });
    } catch (error) {
      this.#o.log?.('purge des runs impossible', error);
    }
  }

  #update(runId: string, patch: RunPatch): ScheduledRun | undefined {
    try {
      const run = this.#o.store.updateRun(runId, patch);
      this.#o.onChange?.({ taskId: run.taskId, run });
      return run;
    } catch (error) {
      // Tâche supprimée pendant le run (runs en cascade) : rien à enregistrer.
      this.#o.log?.('run planifié introuvable', { runId, error });
      return undefined;
    }
  }

  #run(runId: string): ScheduledRun {
    const run = this.#o.store.getRun(runId);
    if (!run) throw new AtelierError('internal', `Run introuvable : ${runId}`);
    return run;
  }

  #task(id: string): ScheduledTask {
    const task = this.#o.store.getTask(id);
    if (!task) throw notFound(id);
    return task;
  }

  #nextRunAt(schedule: Schedule, after: Date): Date {
    return (this.#o.nextRunAt ?? sharedNextRunAt)(schedule, after);
  }

  #id(): string {
    return (this.#o.newId ?? randomUUID)();
  }
}
