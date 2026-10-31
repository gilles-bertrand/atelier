/**
 * Tâches planifiées (ADR-002 D7) : tableau de bord global (période, tuiles,
 * barres quotidiennes par statut, tâches, derniers runs) et formulaire de tâche.
 * La page se relit à chaque `schedule:changed` : un run en cours y apparaît.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import {
  describeSchedule,
  type DeniedAction,
  type ScheduleDashboard,
  type ScheduledRun,
  type ScheduledTask,
  type UsagePeriod,
} from '@atelier/shared';
import { StackedBars, formatDay } from '@renderer/components/charts/StackedBars';
import { StatusDot } from '@renderer/components/status/StatusDot';
import { Button } from '@renderer/components/ui/button';
import { Alert, Switch } from '@renderer/components/ui/primitives';
import { atelier, call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatPercent, formatTokens } from '@renderer/lib/format';
import {
  formatDuration,
  formatRunDate,
  relativeNext,
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
  runDayBars,
  SKIP_REASON_LABELS,
  TRIGGER_LABELS,
} from '@renderer/lib/schedule';
import { fileName } from '@renderer/lib/tool-labels';
import { cn } from '@renderer/lib/utils';
import { useApp } from '@renderer/state/app-state';
import { headerInset, SidebarOpenButton, useShellChrome } from '../sidebar/shell-chrome';
import { TaskForm } from './TaskForm';

/** Runs chargés par page (D7). */
export const RUNS_PAGE = 50;

const PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: '7d', label: '7 jours' },
  { id: '30d', label: '30 jours' },
  { id: 'all', label: 'Tout' },
];

/** Formulaire ouvert : nouvelle tâche, modification, ou « Autoriser pour cette tâche ». */
export type FormRequest = { task?: ScheduledTask; denied?: DeniedAction[] };

export function RunStatus({ run }: { run: Pick<ScheduledRun, 'status' | 'skipReason'> }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
      title={run.skipReason ? `Sauté : ${SKIP_REASON_LABELS[run.skipReason]}` : undefined}
    >
      <StatusDot tone={RUN_STATUS_TONES[run.status]} />
      {RUN_STATUS_LABELS[run.status]}
    </span>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
      {detail ? <dd className="text-xs text-muted-foreground">{detail}</dd> : null}
    </div>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n > 1 ? many : one}`;
}

function TaskRow({
  task,
  onEdit,
  onChanged,
  onError,
}: {
  task: ScheduleDashboard['tasks'][number];
  onEdit: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const run = (action: () => Promise<unknown>): void => {
    action().then(onChanged, (e: unknown) => {
      onError(errorMessage(toSerializedError(e)));
    });
  };
  return (
    <tr className="border-t align-top">
      <th scope="row" className="py-2 pr-3 text-left font-medium">
        {task.name}
      </th>
      <td className="py-2 pr-3">{describeSchedule(task.schedule)}</td>
      <td className="max-w-40 truncate py-2 pr-3 text-muted-foreground" title={task.workspace}>
        {fileName(task.workspace)}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {task.enabled && task.nextRunAt ? relativeNext(new Date(task.nextRunAt), new Date()) : '—'}
      </td>
      <td className="py-2 pr-3">{task.lastRun ? <RunStatus run={task.lastRun} /> : '—'}</td>
      <td className="py-2 pr-3 tabular-nums">
        {task.periodSuccessRate !== undefined
          ? `${formatPercent(task.periodSuccessRate)} (${String(task.periodRuns)})`
          : '—'}
      </td>
      <td className="py-2 pr-3">
        <Switch
          checked={task.enabled}
          aria-label={`Activer « ${task.name} »`}
          onCheckedChange={(enabled) => {
            run(() => call('schedule:set-enabled', { id: task.id, enabled }));
          }}
        />
      </td>
      <td className="py-1.5">
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Exécuter « ${task.name} » maintenant`}
            title="Exécuter maintenant"
            onClick={() => {
              run(() => call('schedule:run-now', { id: task.id }));
            }}
          >
            <Play className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Modifier « ${task.name} »`}
            title="Modifier"
            onClick={onEdit}
          >
            <Pencil className="size-4" aria-hidden />
          </Button>
          {confirming ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                run(() => call('schedule:delete', { id: task.id }));
              }}
              onBlur={() => {
                setConfirming(false);
              }}
            >
              Supprimer la tâche
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Supprimer « ${task.name} »`}
              title="Supprimer"
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function RunsTable({
  runs,
  onOpenSession,
}: {
  runs: readonly ScheduledRun[];
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th scope="col" className="pb-2 pr-3 font-normal">
            Date
          </th>
          <th scope="col" className="pb-2 pr-3 font-normal">
            Tâche
          </th>
          <th scope="col" className="pb-2 pr-3 font-normal">
            Déclencheur
          </th>
          <th scope="col" className="pb-2 pr-3 font-normal">
            Statut
          </th>
          <th scope="col" className="pb-2 pr-3 text-right font-normal">
            Durée
          </th>
          <th scope="col" className="pb-2 pr-3 text-right font-normal">
            Tokens
          </th>
          <th scope="col" className="pb-2 pr-3 text-right font-normal">
            Fichiers
          </th>
          <th scope="col" className="pb-2 pr-3 text-right font-normal">
            Refus
          </th>
          <th scope="col" className="pb-2 font-normal">
            Compte rendu
          </th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className="border-t align-top">
            <td className="py-2 pr-3 whitespace-nowrap">
              {run.sessionId ? (
                <button
                  type="button"
                  onClick={() => {
                    if (run.sessionId) onOpenSession(run.sessionId);
                  }}
                  className="rounded text-left text-brand-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Ouvrir la conversation du run"
                >
                  {formatRunDate(new Date(run.scheduledFor))}
                </button>
              ) : (
                formatRunDate(new Date(run.scheduledFor))
              )}
            </td>
            <td className="py-2 pr-3">{run.taskName}</td>
            <td className="py-2 pr-3 text-muted-foreground">{TRIGGER_LABELS[run.trigger]}</td>
            <td className="py-2 pr-3">
              <RunStatus run={run} />
            </td>
            <td className="py-2 pr-3 text-right tabular-nums">
              {run.durationMs !== undefined ? formatDuration(run.durationMs) : '—'}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums">
              {run.totalTokens !== undefined ? formatTokens(run.totalTokens) : '—'}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums">{run.files.length}</td>
            <td
              className={cn(
                'py-2 pr-3 text-right tabular-nums',
                run.denied.length > 0 ? 'font-medium text-warning-text' : undefined,
              )}
            >
              {run.denied.length}
            </td>
            <td className="max-w-64 py-2 text-muted-foreground">
              <span className="line-clamp-2" title={run.summary}>
                {run.summary ?? (run.skipReason ? SKIP_REASON_LABELS[run.skipReason] : '—')}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Dashboard({
  onNew,
  onEdit,
  onOpenSession,
}: {
  onNew: () => void;
  onEdit: (task: ScheduledTask) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [period, setPeriod] = useState<UsagePeriod>('7d');
  const [dashboard, setDashboard] = useState<ScheduleDashboard | undefined>();
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback((shown: UsagePeriod): void => {
    Promise.all([
      call('schedule:dashboard', { period: shown }),
      call('schedule:runs', { limit: RUNS_PAGE }),
    ]).then(
      ([next, page]) => {
        setDashboard(next);
        setRuns(page);
        setHasMore(page.length === RUNS_PAGE);
        setError(undefined);
      },
      (e: unknown) => {
        setError(errorMessage(toSerializedError(e)));
      },
    );
  }, []);

  useEffect(() => {
    reload(period);
  }, [reload, period]);

  // Mise à jour en direct : statut d'un run, prochaine exécution, tâche modifiée.
  useEffect(
    () =>
      atelier().on('schedule:changed', () => {
        reload(period);
      }),
    [reload, period],
  );

  const loadMore = (): void => {
    const before = runs.at(-1)?.scheduledFor;
    call('schedule:runs', { limit: RUNS_PAGE, ...(before ? { before } : {}) }).then(
      (page) => {
        setRuns((current) => [...current, ...page]);
        setHasMore(page.length === RUNS_PAGE);
      },
      (e: unknown) => {
        setError(errorMessage(toSerializedError(e)));
      },
    );
  };

  if (!dashboard) {
    return error ? (
      <Alert tone="error">{error}</Alert>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Chargement des tâches…
      </p>
    );
  }

  const now = new Date();
  const bars = runDayBars(dashboard.daily, period, now);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Période" className="inline-flex rounded-md border p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={period === p.id}
              onClick={() => {
                setPeriod(p.id);
              }}
              className={cn(
                'rounded px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                period === p.id
                  ? 'bg-brand-soft font-medium text-brand-text'
                  : 'text-muted-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Button onClick={onNew}>
          <Plus className="size-4" aria-hidden />
          Nouvelle tâche
        </Button>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {dashboard.tasks.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
          <CalendarClock className="size-6 text-muted-foreground" aria-hidden />
          <p className="font-medium">Aucune tâche planifiée</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Une tâche exécute une demande toute seule, à intervalle régulier : un rapport chaque
            lundi, une synthèse chaque soir…
          </p>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="Tâches actives"
              value={String(dashboard.activeTasks)}
              detail={
                dashboard.nextRunAt
                  ? `Prochaine : ${relativeNext(new Date(dashboard.nextRunAt), now)}`
                  : 'Aucune exécution prévue'
              }
            />
            <Tile
              label="Exécutions"
              value={String(dashboard.runs)}
              detail={
                dashboard.successRate !== undefined
                  ? `${formatPercent(dashboard.successRate)} de réussite`
                  : 'Aucune exécution terminée'
              }
            />
            <Tile
              label="Durée moyenne"
              value={
                dashboard.avgDurationMs !== undefined
                  ? formatDuration(dashboard.avgDurationMs)
                  : '—'
              }
              detail={`${formatTokens(dashboard.totalTokens)} tokens`}
            />
            <Tile
              label="Actions refusées"
              value={String(dashboard.deniedActions)}
              detail={`${plural(dashboard.skippedRuns, 'exécution sautée', 'exécutions sautées')} ou interrompue${dashboard.skippedRuns > 1 ? 's' : ''}`}
            />
          </dl>

          <StackedBars
            title="Exécutions par jour"
            series={[
              { key: 'success', label: 'Réussies', className: 'bg-success' },
              { key: 'error', label: 'En échec', className: 'bg-destructive' },
              { key: 'skipped', label: 'Sautées', className: 'bg-warning' },
            ]}
            bars={bars.map((bar) => ({
              day: bar.day,
              values: { success: bar.success, error: bar.error, skipped: bar.skipped },
              label: `${formatDay(bar.day)} : ${plural(bar.success, 'réussie', 'réussies')}, ${plural(
                bar.error,
                'en échec',
                'en échec',
              )}, ${plural(bar.skipped, 'sautée', 'sautées')}`,
            }))}
          />

          <section aria-labelledby="schedule-tasks" className="space-y-2">
            <h2 id="schedule-tasks" className="text-sm font-medium">
              Tâches
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="pb-2 pr-3 font-normal">
                      Nom
                    </th>
                    <th scope="col" className="pb-2 pr-3 font-normal">
                      Récurrence
                    </th>
                    <th scope="col" className="pb-2 pr-3 font-normal">
                      Dossier
                    </th>
                    <th scope="col" className="pb-2 pr-3 font-normal">
                      Prochaine exécution
                    </th>
                    <th scope="col" className="pb-2 pr-3 font-normal">
                      Dernier statut
                    </th>
                    <th scope="col" className="pb-2 pr-3 font-normal">
                      Réussite
                    </th>
                    <th scope="col" className="pb-2 pr-3 font-normal">
                      Active
                    </th>
                    <th scope="col" className="pb-2 font-normal">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onEdit={() => {
                        onEdit(task);
                      }}
                      onChanged={() => {
                        reload(period);
                      }}
                      onError={setError}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section aria-labelledby="schedule-runs" className="space-y-2">
        <h2 id="schedule-runs" className="text-sm font-medium">
          Dernières exécutions
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune exécution pour l’instant.</p>
        ) : (
          <div className="overflow-x-auto">
            <RunsTable runs={runs} onOpenSession={onOpenSession} />
          </div>
        )}
        {hasMore ? (
          <Button variant="outline" size="sm" onClick={loadMore}>
            Afficher plus
          </Button>
        ) : null}
      </section>
    </div>
  );
}

export function ScheduleView({
  onOpenSession,
  request,
}: {
  onOpenSession: (sessionId: string) => void;
  /** Formulaire à ouvrir dès l'affichage (« Autoriser pour cette tâche »). */
  request?: FormRequest;
}) {
  const { state, actions } = useApp();
  const { sidebarOpen } = useShellChrome();
  const [form, setForm] = useState<FormRequest | undefined>(request);
  const [proposeLogin, setProposeLogin] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [form]);

  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 border-b pr-4 [-webkit-app-region:drag]',
          headerInset(sidebarOpen),
        )}
      >
        <div className="flex flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
          <SidebarOpenButton />
          <h1 ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">
            {form
              ? form.task
                ? `Modifier « ${form.task.name} »`
                : 'Nouvelle tâche'
              : 'Tâches planifiées'}
          </h1>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6">
          {proposeLogin && state.settings.openAtLogin !== true ? (
            <Alert tone="info" title="Les tâches ne tournent que si Atelier est ouvert">
              <p>
                Ouvrir Atelier à la connexion, fenêtre masquée, pour que vos tâches s’exécutent même
                si vous n’avez pas lancé l’app.
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    void actions.updateSettings({ openAtLogin: true }).then(() => {
                      setProposeLogin(false);
                    });
                  }}
                >
                  Ouvrir à la connexion
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setProposeLogin(false);
                  }}
                >
                  Plus tard
                </Button>
              </div>
            </Alert>
          ) : null}
          {form ? (
            <TaskForm
              {...(form.task ? { task: form.task } : {})}
              {...(form.denied ? { denied: form.denied } : {})}
              onDone={(_task, created) => {
                setForm(undefined);
                if (created) setProposeLogin(true);
              }}
              onCancel={() => {
                setForm(undefined);
              }}
            />
          ) : (
            <Dashboard
              onNew={() => {
                setForm({});
              }}
              onEdit={(task) => {
                setForm({ task });
              }}
              onOpenSession={onOpenSession}
            />
          )}
        </div>
      </main>
    </div>
  );
}
