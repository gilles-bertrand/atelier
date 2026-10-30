/**
 * Jauge de remplissage du contexte (ADR-001 §5) : `● 6 %` en bas à droite du
 * Composer. Elle lit le magasin d'usage isolé : une mise à jour ne re-rend
 * qu'elle. Aucune estimation côté renderer : seuls les chiffres du serveur font foi.
 */
import { COMPACTION_THRESHOLD } from '@atelier/shared';
import { formatPercent, formatTokens } from '@renderer/lib/format';
import { cn } from '@renderer/lib/utils';
import { useSessionUsage } from '@renderer/state/usage-store';
import type { TurnUsage } from '../../../../common/usage';

/** Sous ce ratio, la jauge est verte. */
export const GAUGE_WARNING_RATIO = 0.5;

export type GaugeTone = 'unknown' | 'ok' | 'warning' | 'danger';

export interface GaugeState {
  tone: GaugeTone;
  /** Pourcentage entier (0..100), absent si inconnu. */
  percent?: number;
  label: string;
  tooltip: string;
}

/** État affiché pour un usage (pur, testable). */
export function gaugeState(usage: TurnUsage | undefined): GaugeState {
  if (usage?.contextTokens === undefined) {
    return {
      tone: 'unknown',
      label: '—',
      tooltip: 'Le remplissage s’affichera après la première réponse',
    };
  }
  if (usage.contextWindow === undefined || usage.contextWindow <= 0) {
    return { tone: 'unknown', label: '—', tooltip: 'Fenêtre de contexte inconnue' };
  }
  const ratio = Math.min(1, Math.max(0, usage.contextTokens / usage.contextWindow));
  const tone: GaugeTone =
    ratio < GAUGE_WARNING_RATIO ? 'ok' : ratio < COMPACTION_THRESHOLD ? 'warning' : 'danger';
  return {
    tone,
    percent: Math.round(ratio * 100),
    label: formatPercent(ratio),
    tooltip: `Contexte : ${formatTokens(usage.contextTokens)} / ${formatTokens(
      usage.contextWindow,
    )} tokens · compaction automatique à ${formatPercent(COMPACTION_THRESHOLD)}`,
  };
}

const DOTS: Record<GaugeTone, string> = {
  unknown: 'bg-muted-foreground/40',
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
};

export function ContextGauge({ sessionId }: { sessionId: string }) {
  const state = gaugeState(useSessionUsage(sessionId));
  return (
    <span
      role="meter"
      aria-label="Remplissage du contexte"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(state.percent !== undefined
        ? { 'aria-valuenow': state.percent }
        : { 'aria-valuetext': state.tooltip })}
      title={state.tooltip}
      data-tone={state.tone}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs tabular-nums',
        state.tone === 'unknown' ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      <span className={cn('size-2 rounded-full', DOTS[state.tone])} aria-hidden />
      {state.label}
    </span>
  );
}
