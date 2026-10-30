/**
 * Consommation de tokens (ADR-001, ticket #10) : types locaux, miroirs exacts du
 * §3 de l'ADR, en attendant leur arrivée dans `@atelier/shared` (lot L0 du Lead).
 * Au merge de L0, ces déclarations sont remplacées par des réexports de shared.
 *
 * Code pur partagé par le main (registre) et le renderer (jauge, Réglages).
 */
import type { AgentEvent, DoneReason, TokenUsage } from '@atelier/shared';

export type RelaunchKind =
  | 'continuation'
  | 'stream_cut'
  | 'tool_call_parse'
  | 'empty_final'
  | 'announce_only'
  | 'verification';

export const RELAUNCH_KINDS: readonly RelaunchKind[] = [
  'continuation',
  'stream_cut',
  'tool_call_parse',
  'empty_final',
  'announce_only',
  'verification',
];

/** `TokenUsage` enrichi (champs optionnels ajoutés par L1). */
export interface TurnUsage extends TokenUsage {
  /** Entrée cumulée sur toutes les étapes du tour (tokens réellement traités). */
  totalInputTokens?: number;
  /** Taille du contexte après la dernière étape (entrée + sortie de cette étape) : la jauge. */
  contextTokens?: number;
  /** Nombre d'appels au modèle pendant le tour. */
  steps?: number;
  /** Temps de génération cumulé (1er chunk → fin d'étape), en ms. */
  generationMs?: number;
  /** Relances automatiques du tour, par type (absent = aucune). */
  relaunches?: Partial<Record<RelaunchKind, number>>;
}

/** Event `usage` (membre d'`AgentEvent` après L0) : usage cumulé du tour en cours. */
export interface UsageEvent {
  type: 'usage';
  sessionId: string;
  turnId: string;
  usage: TurnUsage;
}

export type UsagePeriod = '7d' | '30d' | 'all';
export type TurnOutcome = DoneReason | 'error';

export interface ModelUsageStats {
  model: string;
  turns: number;
  steps: number;
  /** Somme des `totalInputTokens`. */
  inputTokens: number;
  outputTokens: number;
  /** (entrée + sortie) / tours. */
  avgTokensPerTurn: number;
  /** Absent si aucun temps de génération mesuré. */
  tokensPerSecond?: number;
  /** Moyenne de contextTokens / contextWindow (0..1). */
  avgContextRatio?: number;
  peakContextRatio?: number;
  compactions: number;
  /** Tours avec au moins une relance. */
  relaunchedTurns: number;
  relaunches: Partial<Record<RelaunchKind, number>>;
  errorTurns: number;
  /** ISO 8601. */
  lastUsedAt: string;
}

export interface UsageDailyPoint {
  /** AAAA-MM-JJ, heure locale. */
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageSummary {
  period: UsagePeriod;
  /** Tri : total décroissant. */
  models: ModelUsageStats[];
  /** Tri : jour croissant. */
  daily: UsageDailyPoint[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Event `usage` reçu par le canal `agent:event`. Tant que L0 n'a pas ajouté le
 * type à l'union `AgentEvent`, on le reconnaît à l'exécution.
 */
export function asUsageEvent(event: AgentEvent | UsageEvent): UsageEvent | undefined {
  const value: unknown = event;
  if (!isRecord(value) || value['type'] !== 'usage' || !isRecord(value['usage'])) return undefined;
  return value as unknown as UsageEvent;
}

/** Usage porté par une réponse (ex. `session:open.usage`), s'il est bien formé. */
export function readUsage(value: unknown): TurnUsage | undefined {
  if (!isRecord(value) || !isRecord(value['usage'])) return undefined;
  const usage = value['usage'];
  return typeof usage['inputTokens'] === 'number' && typeof usage['outputTokens'] === 'number'
    ? (usage as unknown as TurnUsage)
    : undefined;
}

/** Jour local AAAA-MM-JJ (les barres quotidiennes suivent l'heure de l'utilisateur). */
export function localDay(date: Date): string {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Premier jour inclus d'une période (aujourd'hui compris), `undefined` pour « Tout ». */
export function periodStartDay(period: UsagePeriod, now: Date): string | undefined {
  if (period === 'all') return undefined;
  const days = period === '7d' ? 7 : 30;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return localDay(start);
}
