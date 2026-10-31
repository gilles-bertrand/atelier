/**
 * Barres quotidiennes empilées, en CSS (aucune dépendance) : tokens par jour
 * (Réglages › Utilisation, ADR-001) et runs par statut (tâches planifiées,
 * ADR-002). Chaque barre porte son libellé complet pour les lecteurs d'écran.
 */
import { useId } from 'react';
import { cn } from '@renderer/lib/utils';

export interface BarSeries<K extends string> {
  key: K;
  label: string;
  /** Classe de couleur du segment (jeton du thème, ex. `bg-brand`). */
  className: string;
}

export interface StackedBar<K extends string> {
  day: string;
  values: Record<K, number>;
  /** Libellé complet de la barre (« 31 oct. : 3 réussis, 1 en échec »). */
  label: string;
}

const dayLabel = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

/** Jour local `AAAA-MM-JJ` en date (minuit local). */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** « 31 oct. » */
export function formatDay(day: string): string {
  return dayLabel.format(parseDay(day));
}

export function StackedBars<K extends string>({
  title,
  series,
  bars,
}: {
  title: string;
  /** Du bas vers le haut de la barre. */
  series: readonly BarSeries<K>[];
  bars: readonly StackedBar<K>[];
}) {
  const titleId = useId();
  const total = (bar: StackedBar<K>): number =>
    series.reduce((sum, s) => sum + bar.values[s.key], 0);
  const max = Math.max(1, ...bars.map(total));
  return (
    <figure aria-labelledby={titleId} className="space-y-2">
      <figcaption
        id={titleId}
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium"
      >
        {title}
        <span className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <span className={cn('size-2 rounded-sm', s.className)} aria-hidden /> {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      <ol className="flex h-32 items-end gap-px border-b">
        {bars.map((bar) => (
          <li
            key={bar.day}
            title={bar.label}
            className="flex h-full min-w-0 flex-1 flex-col-reverse justify-start"
          >
            <span className="sr-only">{bar.label}</span>
            {series.map((s, i) => (
              <span
                key={s.key}
                aria-hidden
                className={cn(
                  'block',
                  s.className,
                  i === series.length - 1 ? 'rounded-t-[2px]' : undefined,
                  i === 0 && total(bar) > 0 ? 'min-h-px' : undefined,
                )}
                style={{ height: `${String((bar.values[s.key] / max) * 100)}%` }}
              />
            ))}
          </li>
        ))}
      </ol>
      {bars.length > 0 ? (
        <div className="flex justify-between text-xs text-muted-foreground" aria-hidden>
          <span>{formatDay(bars[0]?.day ?? '')}</span>
          <span>{formatDay(bars.at(-1)?.day ?? '')}</span>
        </div>
      ) : null}
    </figure>
  );
}
