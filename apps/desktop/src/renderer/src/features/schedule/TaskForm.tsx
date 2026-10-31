/**
 * Formulaire d'une tâche planifiée (ADR-002 D2, D4, D7) : nom, dossier, demande,
 * modèle, récurrence avec l'aperçu des trois prochaines exécutions, cases de
 * permissions (ce que la tâche peut faire sans vous) et durée maximale.
 */
import { useEffect, useId, useMemo, useState, type SyntheticEvent } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import {
  DEFAULT_MAX_DURATION_MINUTES,
  MAX_MAX_DURATION_MINUTES,
  MIN_MAX_DURATION_MINUTES,
  validateSchedule,
  type DeniedAction,
  type IsoWeekday,
  type LlmModelInfo,
  type Schedule,
  type ScheduledPermissions,
  type ScheduledTask,
  type ScheduledTaskInput,
} from '@atelier/shared';
import { Button } from '@renderer/components/ui/button';
import { Alert, Hint, Input, Label, Select } from '@renderer/components/ui/primitives';
import { call, toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { chatModels } from '@renderer/lib/models';
import {
  formatUpcoming,
  parseList,
  permissionsAfterDenied,
  upcomingRuns,
} from '@renderer/lib/schedule';
import { useApp } from '@renderer/state/app-state';

type Kind = Schedule['kind'];

const KINDS: { id: Kind; label: string }[] = [
  { id: 'interval', label: 'Toutes les N minutes ou heures' },
  { id: 'daily', label: 'Chaque jour' },
  { id: 'weekly', label: 'Certains jours de la semaine' },
  { id: 'monthly', label: 'Chaque mois' },
  { id: 'yearly', label: 'Chaque année' },
];

const WEEKDAYS: { day: IsoWeekday; short: string; long: string }[] = [
  { day: 1, short: 'Lun', long: 'lundi' },
  { day: 2, short: 'Mar', long: 'mardi' },
  { day: 3, short: 'Mer', long: 'mercredi' },
  { day: 4, short: 'Jeu', long: 'jeudi' },
  { day: 5, short: 'Ven', long: 'vendredi' },
  { day: 6, short: 'Sam', long: 'samedi' },
  { day: 7, short: 'Dim', long: 'dimanche' },
];

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

/** Valeurs du formulaire : chaque forme garde ses champs quand on change de forme. */
interface ScheduleFields {
  kind: Kind;
  every: string;
  unit: 'minutes' | 'hours';
  time: string;
  days: IsoWeekday[];
  day: string;
  month: string;
}

function fieldsFrom(schedule: Schedule | undefined): ScheduleFields {
  const base: ScheduleFields = {
    kind: 'daily',
    every: '30',
    unit: 'minutes',
    time: '08:00',
    days: [1],
    day: '1',
    month: '1',
  };
  if (!schedule) return base;
  switch (schedule.kind) {
    case 'interval':
      return { ...base, kind: 'interval', every: String(schedule.every), unit: schedule.unit };
    case 'daily':
      return { ...base, kind: 'daily', time: schedule.time };
    case 'weekly':
      return { ...base, kind: 'weekly', days: schedule.days, time: schedule.time };
    case 'monthly':
      return { ...base, kind: 'monthly', day: String(schedule.day), time: schedule.time };
    case 'yearly':
      return {
        ...base,
        kind: 'yearly',
        month: String(schedule.month),
        day: String(schedule.day),
        time: schedule.time,
      };
  }
}

/** Récurrence décrite par le formulaire (validée ensuite par `validateSchedule`). */
export function scheduleFrom(fields: ScheduleFields): Schedule {
  switch (fields.kind) {
    case 'interval':
      return { kind: 'interval', every: Number(fields.every), unit: fields.unit };
    case 'daily':
      return { kind: 'daily', time: fields.time };
    case 'weekly':
      return { kind: 'weekly', days: [...fields.days].sort((a, b) => a - b), time: fields.time };
    case 'monthly':
      return { kind: 'monthly', day: Number(fields.day), time: fields.time };
    case 'yearly':
      return {
        kind: 'yearly',
        month: Number(fields.month),
        day: Number(fields.day),
        time: fields.time,
      };
  }
}

const NO_PERMISSIONS: ScheduledPermissions = {
  fileWrite: true,
  commands: false,
  webDomains: [],
  mcpTools: [],
};

type WebMode = 'none' | 'all' | 'list';

export function TaskForm({
  task,
  denied,
  onDone,
  onCancel,
}: {
  /** Tâche à modifier ; absente : nouvelle tâche. */
  task?: ScheduledTask;
  /** « Autoriser pour cette tâche » : refus du run, à pré-cocher. */
  denied?: readonly DeniedAction[];
  onDone: (task: ScheduledTask, created: boolean) => void;
  onCancel: () => void;
}) {
  const { state } = useApp();
  const id = useId();
  const ids = {
    name: `${id}-name`,
    prompt: `${id}-prompt`,
    model: `${id}-model`,
    kind: `${id}-kind`,
    every: `${id}-every`,
    unit: `${id}-unit`,
    time: `${id}-time`,
    day: `${id}-day`,
    month: `${id}-month`,
    preview: `${id}-preview`,
    domains: `${id}-domains`,
    domainsHint: `${id}-domains-hint`,
    mcp: `${id}-mcp`,
    mcpHint: `${id}-mcp-hint`,
    duration: `${id}-duration`,
  };
  const granted = useMemo(
    () =>
      denied && denied.length > 0
        ? permissionsAfterDenied(task?.permissions ?? NO_PERMISSIONS, denied)
        : undefined,
    [task, denied],
  );
  const initial = granted?.permissions ?? task?.permissions ?? NO_PERMISSIONS;

  const [name, setName] = useState(task?.name ?? '');
  const [workspace, setWorkspace] = useState(task?.workspace ?? '');
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [model, setModel] = useState(task?.model ?? '');
  const [fields, setFields] = useState(() => fieldsFrom(task?.schedule));
  const [fileWrite, setFileWrite] = useState(initial.fileWrite);
  const [commands, setCommands] = useState(initial.commands);
  const [webMode, setWebMode] = useState<WebMode>(
    initial.webDomains === '*' ? 'all' : initial.webDomains.length > 0 ? 'list' : 'none',
  );
  const [domains, setDomains] = useState(
    initial.webDomains === '*' ? '' : initial.webDomains.join('\n'),
  );
  const [mcpTools, setMcpTools] = useState(initial.mcpTools.join('\n'));
  const [duration, setDuration] = useState(
    String(task?.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES),
  );
  const [models, setModels] = useState<LlmModelInfo[] | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | undefined>();

  useEffect(() => {
    let cancelled = false;
    call('llm:list-models').then(
      (list) => {
        if (!cancelled) setModels(chatModels(list));
      },
      () => {
        if (!cancelled) setModels([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const schedule = scheduleFrom(fields);
  const scheduleProblem = validateSchedule(schedule);
  const upcoming = scheduleProblem === undefined ? upcomingRuns(schedule, new Date()) : [];
  const durationValue = Number(duration);
  const durationInvalid =
    !Number.isInteger(durationValue) ||
    durationValue < MIN_MAX_DURATION_MINUTES ||
    durationValue > MAX_MAX_DURATION_MINUTES;

  const update = (patch: Partial<ScheduleFields>): void => {
    setFields((current) => ({ ...current, ...patch }));
  };

  const chooseFolder = async (): Promise<void> => {
    const dir = await call('dialog:choose-directory', {
      title: 'Dossier de la tâche',
      ...(workspace ? { defaultPath: workspace } : {}),
    });
    if (dir !== null) setWorkspace(dir);
  };

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (scheduleProblem !== undefined || durationInvalid) return;
    const input: ScheduledTaskInput = {
      name,
      prompt,
      workspace,
      ...(model !== '' ? { model } : {}),
      schedule,
      permissions: {
        fileWrite,
        commands,
        webDomains: webMode === 'all' ? '*' : webMode === 'list' ? parseList(domains) : [],
        mcpTools: parseList(mcpTools),
      },
      maxDurationMinutes: durationValue,
      enabled: task?.enabled ?? true,
    };
    setSaving(true);
    setError(undefined);
    try {
      const saved = await call('schedule:save', { ...(task ? { id: task.id } : {}), task: input });
      onDone(saved, task === undefined);
    } catch (e) {
      const serialized = toSerializedError(e);
      const field = serialized.details?.['field'];
      setError({
        ...(typeof field === 'string' ? { field } : {}),
        message: errorMessage(serialized),
      });
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (field: string): string | undefined =>
    error?.field === field ? error.message : undefined;
  const defaultModel = state.settings.llm.model;

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-6" noValidate>
      {granted ? (
        <Alert tone="info" title="Autoriser pour cette tâche">
          Les cases correspondant aux actions refusées pendant le run sont cochées. Vérifiez-les,
          puis enregistrez.
          {granted.notGrantable.length > 0 ? (
            <span className="mt-1 block">
              Jamais autorisé sans vous : {granted.notGrantable.map((d) => d.title).join(', ')}.
            </span>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={ids.name}>Nom</Label>
          <Input
            id={ids.name}
            value={name}
            placeholder="Rapport hebdomadaire"
            aria-invalid={fieldError('name') ? true : undefined}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          {fieldError('name') ? (
            <Hint className="text-destructive">{fieldError('name')}</Hint>
          ) : null}
        </div>
        <div className="space-y-2">
          <span className="text-sm font-medium">Dossier</span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void chooseFolder()}>
              <FolderOpen className="size-4" aria-hidden />
              {workspace ? 'Changer…' : 'Choisir…'}
            </Button>
            <span className="min-w-0 truncate text-sm text-muted-foreground" title={workspace}>
              {workspace || 'Aucun dossier choisi'}
            </span>
          </div>
          {fieldError('workspace') ? (
            <Hint className="text-destructive">{fieldError('workspace')}</Hint>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.prompt}>Demande</Label>
        <textarea
          id={ids.prompt}
          value={prompt}
          rows={4}
          placeholder="Résume les fichiers ajoutés cette semaine dans rapport.md."
          aria-invalid={fieldError('prompt') ? true : undefined}
          onChange={(e) => {
            setPrompt(e.target.value);
          }}
          className="block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {fieldError('prompt') ? (
          <Hint className="text-destructive">{fieldError('prompt')}</Hint>
        ) : (
          <Hint>
            Elle est envoyée telle quelle à chaque exécution, dans une nouvelle conversation.
          </Hint>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={ids.model}>Modèle</Label>
        <Select
          id={ids.model}
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
          }}
          className="max-w-sm"
        >
          <option value="">Modèle par défaut des Réglages ({defaultModel})</option>
          {(models ?? []).map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
          {model !== '' && models && !models.some((m) => m.name === model) ? (
            <option value={model}>{model}</option>
          ) : null}
        </Select>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Récurrence</legend>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={ids.kind} className="text-xs text-muted-foreground">
              Fréquence
            </Label>
            <Select
              id={ids.kind}
              value={fields.kind}
              onChange={(e) => {
                update({ kind: e.target.value as Kind });
              }}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </Select>
          </div>
          {fields.kind === 'interval' ? (
            <>
              <div className="space-y-1">
                <Label htmlFor={ids.every} className="text-xs text-muted-foreground">
                  Toutes les
                </Label>
                <Input
                  id={ids.every}
                  inputMode="numeric"
                  value={fields.every}
                  onChange={(e) => {
                    update({ every: e.target.value.replace(/[^\d]/g, '') });
                  }}
                  className="w-20"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={ids.unit} className="text-xs text-muted-foreground">
                  Unité
                </Label>
                <Select
                  id={ids.unit}
                  value={fields.unit}
                  onChange={(e) => {
                    update({ unit: e.target.value as 'minutes' | 'hours' });
                  }}
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">heures</option>
                </Select>
              </div>
            </>
          ) : null}
          {fields.kind === 'yearly' ? (
            <div className="space-y-1">
              <Label htmlFor={ids.month} className="text-xs text-muted-foreground">
                Mois
              </Label>
              <Select
                id={ids.month}
                value={fields.month}
                onChange={(e) => {
                  update({ month: e.target.value });
                }}
              >
                {MONTHS.map((label, i) => (
                  <option key={label} value={String(i + 1)}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {fields.kind === 'monthly' || fields.kind === 'yearly' ? (
            <div className="space-y-1">
              <Label htmlFor={ids.day} className="text-xs text-muted-foreground">
                Jour
              </Label>
              <Input
                id={ids.day}
                inputMode="numeric"
                value={fields.day}
                onChange={(e) => {
                  update({ day: e.target.value.replace(/[^\d]/g, '') });
                }}
                className="w-20"
              />
            </div>
          ) : null}
          {fields.kind !== 'interval' ? (
            <div className="space-y-1">
              <Label htmlFor={ids.time} className="text-xs text-muted-foreground">
                Heure
              </Label>
              <Input
                id={ids.time}
                type="time"
                value={fields.time}
                onChange={(e) => {
                  update({ time: e.target.value });
                }}
                className="w-32"
              />
            </div>
          ) : null}
        </div>
        {fields.kind === 'weekly' ? (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Jours de la semaine</legend>
            {WEEKDAYS.map((w) => {
              const checked = fields.days.includes(w.day);
              return (
                <label
                  key={w.day}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={w.long}
                    onChange={() => {
                      update({
                        days: checked
                          ? fields.days.filter((d) => d !== w.day)
                          : [...fields.days, w.day],
                      });
                    }}
                    className="size-3.5 accent-brand"
                  />
                  <span aria-hidden>{w.short}</span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
        <div id={ids.preview} aria-live="polite">
          {scheduleProblem !== undefined ? (
            <Hint className="text-destructive">{scheduleProblem}</Hint>
          ) : (
            <div className="text-sm">
              <p className="text-muted-foreground">Prochaines exécutions :</p>
              <ul aria-label="Prochaines exécutions" className="mt-1 list-inside list-disc">
                {upcoming.map((date) => (
                  <li key={date.toISOString()}>{formatUpcoming(date)}</li>
                ))}
              </ul>
            </div>
          )}
          {fieldError('schedule') ? (
            <Hint className="text-destructive">{fieldError('schedule')}</Hint>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Ce que la tâche peut faire sans vous</legend>
        <p className="text-sm text-muted-foreground">
          Toujours permis : lire les fichiers du dossier, chercher sur le web, utiliser les
          connecteurs en lecture. Tout ce qui n’est pas coché ci-dessous est refusé, et chaque refus
          apparaît dans le tableau de bord.
        </p>
        <Checkbox
          checked={fileWrite}
          onChange={setFileWrite}
          label="Créer et modifier des fichiers dans le dossier"
        />
        <Checkbox
          checked={commands}
          onChange={setCommands}
          label="Exécuter des commandes dans la machine isolée"
          hint="La machine isolée sert alors à la tâche pendant son exécution."
        />
        <fieldset className="space-y-2">
          <legend className="text-sm">Lire des pages web</legend>
          {(
            [
              ['none', 'Non'],
              ['all', 'Tous les sites'],
              ['list', 'Seulement ces sites'],
            ] as const
          ).map(([mode, label]) => (
            <label key={mode} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-web`}
                checked={webMode === mode}
                onChange={() => {
                  setWebMode(mode);
                }}
                className="size-4 accent-brand"
              />
              {label}
            </label>
          ))}
          {webMode === 'list' ? (
            <div className="space-y-1 pl-6">
              <Label htmlFor={ids.domains} className="sr-only">
                Sites autorisés
              </Label>
              <textarea
                id={ids.domains}
                value={domains}
                rows={2}
                placeholder="example.com"
                aria-describedby={ids.domainsHint}
                onChange={(e) => {
                  setDomains(e.target.value);
                }}
                className="block w-full max-w-md rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Hint id={ids.domainsHint}>
                Un domaine par ligne. Les sous-domaines (docs.example.com…) doivent être ajoutés
                séparément.
              </Hint>
            </div>
          ) : null}
          {commands && webMode !== 'none' ? (
            <Hint>Internet est aussi ouvert à la machine isolée pendant l’exécution.</Hint>
          ) : null}
        </fieldset>
        <div className="space-y-1">
          <Label htmlFor={ids.mcp} className="text-sm font-normal">
            Connecteurs en écriture autorisés
          </Label>
          <textarea
            id={ids.mcp}
            value={mcpTools}
            rows={2}
            placeholder="mcp__github__create_issue"
            aria-describedby={ids.mcpHint}
            onChange={(e) => {
              setMcpTools(e.target.value);
            }}
            className="block w-full max-w-md rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Hint id={ids.mcpHint}>
            Un outil par ligne, sous la forme mcp__serveur__outil. Laissez vide pour n’en autoriser
            aucun.
          </Hint>
        </div>
        <p className="text-sm text-muted-foreground">
          Jamais sans vous : supprimer des fichiers, et toute action d’un type inconnu.
        </p>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor={ids.duration}>Durée maximale d’une exécution (minutes)</Label>
        <Input
          id={ids.duration}
          inputMode="numeric"
          value={duration}
          aria-invalid={durationInvalid ? true : undefined}
          onChange={(e) => {
            setDuration(e.target.value.replace(/[^\d]/g, ''));
          }}
          className="w-24"
        />
        <Hint className={durationInvalid ? 'text-destructive' : undefined}>
          {`Entre ${String(MIN_MAX_DURATION_MINUTES)} et ${String(MAX_MAX_DURATION_MINUTES)} minutes. Au-delà, l’exécution est arrêtée.`}
        </Hint>
      </div>

      {error && error.field === undefined ? <Alert tone="error">{error.message}</Alert> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving || scheduleProblem !== undefined || durationInvalid}>
          {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Enregistrer
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5 size-4 accent-brand"
      />
      <div>
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
        {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
      </div>
    </div>
  );
}
