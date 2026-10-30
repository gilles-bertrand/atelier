/**
 * Statistiques d'utilisation du modèle (Réglages › Utilisation), calculées par
 * le process main à partir du registre local des tours (une ligne par tour,
 * SQLite). Rien ne quitte la machine. Voir `docs/adr/ADR-001-consommation-tokens.md`.
 */
import type { DoneReason } from './events.js';
import type { RelaunchKind } from './messages.js';

/** Période des statistiques. */
export type UsagePeriod = '7d' | '30d' | 'all';

/** Issue d'un tour enregistré : fin normale, annulée, tronquée, ou erreur. */
export type TurnOutcome = DoneReason | 'error';

/** Agrégats d'un modèle sur la période. */
export interface ModelUsageStats {
  /** Nom du modèle au moment des tours (ex. `qwen3.5:35b`). */
  model: string;
  /** Nombre de tours. */
  turns: number;
  /** Nombre d'appels au modèle (étapes). */
  steps: number;
  /** Tokens d'entrée traités (somme des `totalInputTokens`). */
  inputTokens: number;
  /** Tokens générés. */
  outputTokens: number;
  /** (entrée + sortie) / tours. */
  avgTokensPerTurn: number;
  /** Débit de génération moyen ; absent sans mesure de durée. */
  tokensPerSecond?: number;
  /** Remplissage moyen du contexte en fin de tour (0..1). */
  avgContextRatio?: number;
  /** Remplissage maximal du contexte en fin de tour (0..1). */
  peakContextRatio?: number;
  /** Compactions de l'historique pendant ces tours. */
  compactions: number;
  /** Tours avec au moins une relance automatique. */
  relaunchedTurns: number;
  /** Relances par type. */
  relaunches: Partial<Record<RelaunchKind, number>>;
  /** Tours terminés en erreur. */
  errorTurns: number;
  /** Dernier tour, horodatage ISO 8601. */
  lastUsedAt: string;
}

/** Point de la série quotidienne (un par jour et par modèle). */
export interface UsageDailyPoint {
  /** Jour `AAAA-MM-JJ`, heure locale. */
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/** Réponse de `usage:summary`. */
export interface UsageSummary {
  period: UsagePeriod;
  /** Tri : total (entrée + sortie) décroissant. */
  models: ModelUsageStats[];
  /** Tri : jour croissant, puis modèle. */
  daily: UsageDailyPoint[];
}
