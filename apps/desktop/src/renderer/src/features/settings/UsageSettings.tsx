/**
 * Réglages › Utilisation (ADR-001 §5) : tokens consommés par modèle et KPI, sur
 * 7 jours, 30 jours ou depuis le début. Les agrégats viennent du main (SQL) ;
 * l'écran ne fait qu'additionner les lignes par modèle pour les tuiles.
 * Données locales uniquement : rien ne sort de la machine.
 */
import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Alert } from '@renderer/components/ui/primitives';
import { toSerializedError } from '@renderer/lib/api';
import { errorMessage } from '@renderer/lib/error-messages';
import { formatDecimal, formatPercent, formatTokens } from '@renderer/lib/format';
import { loadUsageSummary } from '@renderer/lib/usage-api';
import { cn } from '@renderer/lib/utils';
import {
  localDay,
  periodStartDay,
  RELAUNCH_KINDS,
  type ModelUsageStats,
  type RelaunchKind,
  type UsageDailyPoint,
  type UsagePeriod,
  type UsageSummary,
} from '../../../../common/usage';
import { SettingsSection } from './common';

const PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: '7d', label: '7 jours' },
  { id: '30d', label: '30 jours' },
  { id: 'all', label: 'Tout' },
];

export const RELAUNCH_LABELS: Record<RelaunchKind, string> = {
  continuation: 'Suite demandée',
  stream_cut: 'Flux coupé',
  tool_call_parse: 'Appel d’outil illisible',
  empty_final: 'Réponse vide',
  announce_only: 'Annonce sans action',
  verification: 'Vérification',
};

const dayLabel = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function rate(part: number, total: number): string {
  return total > 0 ? formatPercent(part / total) : '—';
}

/** Totaux affichés dans les tuiles (sommes des lignes par modèle). */
export function usageTotals(models: readonly ModelUsageStats[]) {
  const sum = (pick: (m: ModelUsageStats) => number): number =>
    models.reduce((total, m) => total + pick(m), 0);
  const inputTokens = sum((m) => m.inputTokens);
  const outputTokens = sum((m) => m.outputTokens);
  const turns = sum((m) => m.turns);
  // Débit global : sortie totale / temps de génération total (déduit du débit de chaque modèle).
  const timed = models.filter((m) => m.tokensPerSecond !== undefined && m.tokensPerSecond > 0);
  const seconds = timed.reduce((t, m) => t + m.outputTokens / (m.tokensPerSecond ?? 1), 0);
  const peaks = models.flatMap((m) =>
    m.peakContextRatio !== undefined ? [m.peakContextRatio] : [],
  );
  return {
    inputTokens,
    outputTokens,
    turns,
    avgPerTurn: turns > 0 ? (inputTokens + outputTokens) / turns : 0,
    tokensPerSecond:
      seconds > 0 ? timed.reduce((t, m) => t + m.outputTokens, 0) / seconds : undefined,
    peakContextRatio: peaks.length > 0 ? Math.max(...peaks) : undefined,
    compactions: sum((m) => m.compactions),
  };
}

interface DayBar {
  day: string;
  inputTokens: number;
  outputTokens: number;
}

/** Barres quotidiennes, tous modèles confondus ; jours sans activité inclus sur 7 j / 30 j. */
export function dailyBars(
  points: readonly UsageDailyPoint[],
  period: UsagePeriod,
  now: Date,
): DayBar[] {
  const byDay = new Map<string, DayBar>();
  const start = periodStartDay(period, now);
  if (start !== undefined) {
    for (let d = parseDay(start); localDay(d) <= localDay(now); d.setDate(d.getDate() + 1)) {
      const day = localDay(d);
      byDay.set(day, { day, inputTokens: 0, outputTokens: 0 });
    }
  }
  for (const point of points) {
    const bar = byDay.get(point.day) ?? { day: point.day, inputTokens: 0, outputTokens: 0 };
    bar.inputTokens += point.inputTokens;
    bar.outputTokens += point.outputTokens;
    byDay.set(point.day, bar);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
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

function DailyChart({ bars }: { bars: readonly DayBar[] }) {
  const titleId = useId();
  const max = Math.max(1, ...bars.map((b) => b.inputTokens + b.outputTokens));
  return (
    <figure aria-labelledby={titleId} className="space-y-2">
      <figcaption id={titleId} className="flex items-center gap-4 text-sm font-medium">
        Tokens par jour
        <span className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-primary/40" aria-hidden /> Entrée
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-primary" aria-hidden /> Sortie
          </span>
        </span>
      </figcaption>
      <ol className="flex h-32 items-end gap-px border-b">
        {bars.map((bar) => {
          const total = bar.inputTokens + bar.outputTokens;
          const label = `${dayLabel.format(parseDay(bar.day))} : ${formatTokens(
            bar.inputTokens,
          )} en entrée, ${formatTokens(bar.outputTokens)} en sortie`;
          return (
            <li
              key={bar.day}
              title={label}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
            >
              <span className="sr-only">{label}</span>
              <span
                aria-hidden
                className="block bg-primary"
                style={{ height: `${String((bar.outputTokens / max) * 100)}%` }}
              />
              <span
                aria-hidden
                className={cn('block bg-primary/40', total > 0 ? 'min-h-px' : undefined)}
                style={{ height: `${String((bar.inputTokens / max) * 100)}%` }}
              />
            </li>
          );
        })}
      </ol>
      {bars.length > 0 ? (
        <div className="flex justify-between text-xs text-muted-foreground" aria-hidden>
          <span>{dayLabel.format(parseDay(bars[0]?.day ?? ''))}</span>
          <span>{dayLabel.format(parseDay(bars.at(-1)?.day ?? ''))}</span>
        </div>
      ) : null}
    </figure>
  );
}

function relaunchDetail(model: ModelUsageStats): string {
  const parts = RELAUNCH_KINDS.flatMap((kind) => {
    const count = model.relaunches[kind];
    return count ? [`${RELAUNCH_LABELS[kind]} : ${String(count)}`] : [];
  });
  return parts.length > 0 ? parts.join(' · ') : 'Aucune relance';
}

function ModelTable({ models }: { models: readonly ModelUsageStats[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <caption className="sr-only">Consommation par modèle</caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-3 font-medium">
              Modèle
            </th>
            {[
              'Tours',
              'Entrée',
              'Sortie',
              'Moy./tour',
              'tokens/s',
              'Contexte moy./pic',
              'Compactions',
              'Tours relancés',
              'Erreurs',
            ].map((label) => (
              <th key={label} scope="col" className="px-2 py-2 text-right font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {models.map((m) => (
            <tr key={m.model} className="border-b last:border-0">
              <th scope="row" className="max-w-48 truncate py-2 pr-3 text-left font-mono text-xs">
                {m.model}
              </th>
              <td className="px-2 py-2 text-right">{formatTokens(m.turns)}</td>
              <td className="px-2 py-2 text-right">{formatTokens(m.inputTokens)}</td>
              <td className="px-2 py-2 text-right">{formatTokens(m.outputTokens)}</td>
              <td className="px-2 py-2 text-right">{formatTokens(m.avgTokensPerTurn)}</td>
              <td className="px-2 py-2 text-right">
                {m.tokensPerSecond !== undefined ? formatDecimal(m.tokensPerSecond) : '—'}
              </td>
              <td className="px-2 py-2 text-right">
                {m.avgContextRatio !== undefined && m.peakContextRatio !== undefined
                  ? `${formatPercent(m.avgContextRatio)} / ${formatPercent(m.peakContextRatio)}`
                  : '—'}
              </td>
              <td className="px-2 py-2 text-right">{formatTokens(m.compactions)}</td>
              <td className="px-2 py-2 text-right" title={relaunchDetail(m)}>
                {formatTokens(m.relaunchedTurns)} ({rate(m.relaunchedTurns, m.turns)})
                <span className="sr-only">. {relaunchDetail(m)}</span>
              </td>
              <td className="px-2 py-2 text-right">
                {formatTokens(m.errorTurns)} ({rate(m.errorTurns, m.turns)})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Loaded =
  { period: UsagePeriod; summary: UsageSummary } | { period: UsagePeriod; error: string };

export function UsageSettings({
  load = loadUsageSummary,
  now,
}: {
  load?: (period: UsagePeriod) => Promise<UsageSummary>;
  /** Date de référence (tests). */
  now?: Date;
}) {
  const [period, setPeriod] = useState<UsagePeriod>('30d');
  const [loaded, setLoaded] = useState<Loaded | undefined>();

  // Relu à l'ouverture et au changement de période (pas de suivi en direct).
  useEffect(() => {
    let cancelled = false;
    load(period).then(
      (summary) => {
        if (!cancelled) setLoaded({ period, summary });
      },
      (e: unknown) => {
        if (!cancelled) setLoaded({ period, error: errorMessage(toSerializedError(e)) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, period]);

  const current = loaded?.period === period ? loaded : undefined;
  const summary = current && 'summary' in current ? current.summary : undefined;
  const totals = summary ? usageTotals(summary.models) : undefined;

  return (
    <SettingsSection
      title="Utilisation"
      description="Tokens consommés par modèle sur cet ordinateur. Ces statistiques restent locales : rien n’est envoyé ailleurs."
    >
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
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:bg-accent/60',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {current === undefined ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Chargement…
        </p>
      ) : 'error' in current ? (
        <Alert tone="error">{current.error}</Alert>
      ) : summary === undefined || totals === undefined || summary.models.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucune consommation enregistrée sur la période.
        </p>
      ) : (
        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="Tokens"
              value={formatTokens(totals.inputTokens + totals.outputTokens)}
              detail={`${formatTokens(totals.inputTokens)} entrée · ${formatTokens(
                totals.outputTokens,
              )} sortie`}
            />
            <Tile
              label="Tours"
              value={formatTokens(totals.turns)}
              detail={`${formatTokens(totals.avgPerTurn)} tokens par tour`}
            />
            <Tile
              label="Débit moyen"
              value={
                totals.tokensPerSecond !== undefined
                  ? `${formatDecimal(totals.tokensPerSecond)} tokens/s`
                  : '—'
              }
              detail="Temps de génération seul"
            />
            <Tile
              label="Pic de contexte"
              value={
                totals.peakContextRatio !== undefined ? formatPercent(totals.peakContextRatio) : '—'
              }
              detail={`${formatTokens(totals.compactions)} compaction${
                totals.compactions > 1 ? 's' : ''
              }`}
            />
          </dl>
          <DailyChart bars={dailyBars(summary.daily, period, now ?? new Date())} />
          <ModelTable models={summary.models} />
        </div>
      )}
    </SettingsSection>
  );
}
