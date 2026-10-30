/**
 * Consommation de tokens d'un tour, enrichie pour la jauge de contexte et les KPI
 * d'utilisation (ticket #10, ADR-001 §2 D1 à D5).
 *
 * Types locaux, miroirs du contrat §3 demandé à `@atelier/shared` : à remplacer
 * par ceux de shared au merge du lot L0 (`feat/lead-shared-token-usage`).
 */
import type { AgentEvent, TokenUsage } from '@atelier/shared';
import type { InjectedKind } from './compaction.js';

/** Relances automatiques comptées (ni `summary` ni `skill`, qui n'en sont pas). */
export type RelaunchKind = Exclude<InjectedKind, 'summary' | 'skill'>;

/** Liste des relances comptées, dans l'ordre de l'ADR. */
export const RELAUNCH_KINDS: readonly RelaunchKind[] = [
  'continuation',
  'stream_cut',
  'tool_call_parse',
  'empty_final',
  'announce_only',
  'verification',
];

/** `TokenUsage` enrichi (ADR-001 §3). Les champs existants gardent leur sens. */
export interface TurnTokenUsage extends TokenUsage {
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

/** Usage cumulé du tour en cours, émis après chaque étape (jauge en temps réel). */
export interface UsageEvent {
  type: 'usage';
  sessionId: string;
  turnId: string;
  usage: TurnTokenUsage;
}

/** Événements émis par la boucle : ceux de shared, plus `usage` en attendant L0. */
export type CoreAgentEvent = AgentEvent | UsageEvent;

/** Débit en tokens/s (sortie / temps de génération), ou `undefined` sans mesure. */
export function tokensPerSecond(usage: TurnTokenUsage): number | undefined {
  const ms = usage.generationMs;
  if (ms === undefined || ms <= 0) return undefined;
  return (usage.outputTokens / ms) * 1000;
}

/**
 * Compteurs d'un tour : alimentés à chaque `finish-step` et à chaque relance,
 * lus par {@link TurnUsageMeter.snapshot} sur toutes les sorties du tour.
 */
export class TurnUsageMeter {
  readonly #clock: () => number;
  readonly #contextWindow: number;
  #lastInputTokens: number | undefined;
  #outputTokens = 0;
  #totalInputTokens = 0;
  #contextTokens: number | undefined;
  #steps = 0;
  #generationMs = 0;
  #firstChunkAt: number | undefined;
  readonly #relaunches: Partial<Record<RelaunchKind, number>> = {};

  constructor(contextWindow: number, clock: () => number) {
    this.#contextWindow = contextWindow;
    this.#clock = clock;
  }

  /** Nombre d'étapes terminées. */
  get steps(): number {
    return this.#steps;
  }

  /** Début d'étape : le chrono attend le premier chunk. */
  startStep(): void {
    this.#firstChunkAt = undefined;
  }

  /** Premier chunk de l'étape (texte, raisonnement ou entrée d'outil) ; les suivants sont ignorés. */
  chunk(): void {
    this.#firstChunkAt ??= this.#clock();
  }

  /** Fin d'étape : cumule les tokens et le temps de génération. */
  finishStep(stepUsage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
  }): void {
    this.#steps += 1;
    const input = stepUsage.inputTokens;
    const output = stepUsage.outputTokens ?? 0;
    if (input !== undefined) {
      this.#lastInputTokens = input;
      this.#totalInputTokens += input;
    }
    this.#outputTokens += output;
    this.#contextTokens = (input ?? this.#lastInputTokens ?? 0) + output;
    if (this.#firstChunkAt !== undefined) {
      this.#generationMs += Math.max(0, this.#clock() - this.#firstChunkAt);
      this.#firstChunkAt = undefined;
    }
  }

  /** Relance automatique du tour. */
  relaunch(kind: RelaunchKind): void {
    this.#relaunches[kind] = (this.#relaunches[kind] ?? 0) + 1;
  }

  /** Usage cumulé jusqu'ici (copie). */
  snapshot(): TurnTokenUsage {
    const relaunches =
      Object.keys(this.#relaunches).length > 0 ? { ...this.#relaunches } : undefined;
    return {
      inputTokens: this.#lastInputTokens ?? 0,
      outputTokens: this.#outputTokens,
      contextWindow: this.#contextWindow,
      totalInputTokens: this.#totalInputTokens,
      ...(this.#contextTokens !== undefined ? { contextTokens: this.#contextTokens } : {}),
      steps: this.#steps,
      generationMs: Math.round(this.#generationMs),
      ...(relaunches ? { relaunches } : {}),
    };
  }
}

/** Bilan de fin de tour : contexte, sortie, débit (tokens/s) et relances. */
export function usageLine(usage: TurnTokenUsage): string {
  const parts = [
    `contexte ${usage.contextTokens ?? usage.inputTokens}/${usage.contextWindow ?? '?'}`,
    `sortie ${usage.outputTokens} tokens`,
  ];
  const rate = tokensPerSecond(usage);
  if (rate !== undefined) parts.push(`${rate.toFixed(1)} tokens/s`);
  if (usage.steps !== undefined) parts.push(`${usage.steps} étape${usage.steps > 1 ? 's' : ''}`);
  const relaunches = Object.entries(usage.relaunches ?? {});
  if (relaunches.length > 0) {
    parts.push(`relances ${relaunches.map(([kind, n]) => `${kind}×${n}`).join(', ')}`);
  }
  return parts.join(' · ');
}
