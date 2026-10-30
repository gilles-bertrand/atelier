/**
 * Jauge de remplissage du contexte (ADR-001 §5) : `● 6 %` en bas à droite du
 * Composer. Elle lit le magasin d'usage isolé : une mise à jour ne re-rend
 * qu'elle. Aucune estimation côté renderer : seuls les chiffres du serveur font foi.
 */
import { COMPACTION_THRESHOLD, type TokenUsage } from '@atelier/shared';
import { formatPercent, formatTokens } from '@renderer/lib/format';
import { cn } from '@renderer/lib/utils';
import { useSessionUsage } from '@renderer/state/usage-store';

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
export function gaugeState(usage: TokenUsage | undefined): GaugeState {
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

/** Couleur de l'arc : jade sous 50 %, ambre jusqu'au seuil de compaction, rouge au-delà. */
const ARCS: Record<Exclude<GaugeTone, 'unknown'>, string> = {
  ok: 'stroke-success',
  warning: 'stroke-warning',
  danger: 'stroke-destructive',
};

/** Anneau qui se remplit ; seul le fond s'affiche tant que le remplissage est inconnu. */
function GaugeRing({ tone, percent }: { tone: GaugeTone; percent: number | undefined }) {
  // Un arc minimal reste visible quand le contexte est presque vide.
  const arc = tone !== 'unknown' && percent !== undefined ? Math.max(percent, 3) : undefined;
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 -rotate-90" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2.5"
        className="stroke-muted-foreground/25"
      />
      {arc !== undefined && tone !== 'unknown' ? (
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${String(arc)} 100`}
          className={ARCS[tone]}
        />
      ) : null}
    </svg>
  );
}

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
      <GaugeRing tone={state.tone} percent={state.percent} />
      {state.label}
    </span>
  );
}
