/**
 * Mesure de la consommation de tokens d'un tour, pour la jauge de contexte et les
 * KPI d'utilisation (ticket #10, ADR-001 §2 D1 à D5). Types : `@atelier/shared`.
 */
import type { RelaunchKind, TokenUsage } from '@atelier/shared';

/** Débit en tokens/s (sortie / temps de génération), ou `undefined` sans mesure. */
export function tokensPerSecond(usage: TokenUsage): number | undefined {
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
  snapshot(): TokenUsage {
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
export function usageLine(usage: TokenUsage): string {
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
