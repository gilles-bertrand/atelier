/**
 * Registre de consommation (ADR-001 §2 D2) : une ligne par tour, clé `turn_id`,
 * écrite en upsert (rejouer l'écriture d'un tour ne compte jamais deux fois).
 * Les agrégats sont calculés en SQL ; la version en mémoire (tests, mode dégradé
 * sans base) applique exactement les mêmes règles en TypeScript.
 *
 * Souveraineté : tout reste dans `userData/atelier.db`, rien ne sort de la machine.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  localDay,
  periodStartDay,
  RELAUNCH_KINDS,
  type ModelUsageStats,
  type RelaunchKind,
  type TurnOutcome,
  type TurnUsage,
  type UsageDailyPoint,
  type UsagePeriod,
  type UsageSummary,
} from '../../common/usage.js';

/** Une ligne du registre. */
export interface UsageRecord {
  turnId: string;
  /** `undefined` une fois la conversation supprimée. */
  sessionId: string | undefined;
  /** Modèle du runtime au moment du tour. */
  model: string;
  outcome: TurnOutcome;
  /** AAAA-MM-JJ, heure locale. */
  day: string;
  steps: number;
  /** Entrée cumulée du tour (`totalInputTokens`). */
  inputTokens: number;
  outputTokens: number;
  contextTokens: number | undefined;
  contextWindow: number | undefined;
  generationMs: number;
  compactions: number;
  relaunches: Partial<Record<RelaunchKind, number>>;
  /** ISO 8601. */
  createdAt: string;
}

export interface UsageStore {
  /** Ajoute ou remplace (même `turnId`) l'enregistrement d'un tour. */
  record(record: UsageRecord): void;
  /** Agrégats par modèle et par jour sur la période. */
  summary(period: UsagePeriod, now?: Date): UsageSummary;
  /** Dernier usage connu d'une conversation (jauge à la réouverture). */
  lastForSession(sessionId: string): TurnUsage | undefined;
  /** Conversation supprimée : ses tours restent comptés, sans lien (SET NULL). */
  detachSession(sessionId: string): void;
}

/** Relances strictement positives, dans l'ordre canonique (JSON stable). */
export function normalizeRelaunches(
  relaunches: Partial<Record<RelaunchKind, number>> | undefined,
): Partial<Record<RelaunchKind, number>> {
  const out: Partial<Record<RelaunchKind, number>> = {};
  for (const kind of RELAUNCH_KINDS) {
    const count = relaunches?.[kind];
    if (typeof count === 'number' && count > 0) out[kind] = count;
  }
  return out;
}

/**
 * Enregistrement d'un tour à partir de `TurnResult.usage` (autoritaire, présent
 * aussi en erreur). Avant L1, les champs enrichis manquent : entrée = celle de
 * la dernière étape, une étape, pas de durée ni de contexte (aucune estimation).
 */
export function usageRecord(options: {
  turnId: string;
  sessionId: string;
  model: string;
  outcome: TurnOutcome;
  usage: TurnUsage;
  compactions: number;
  at: Date;
}): UsageRecord {
  const { usage } = options;
  return {
    turnId: options.turnId,
    sessionId: options.sessionId,
    model: options.model,
    outcome: options.outcome,
    day: localDay(options.at),
    steps: usage.steps ?? 1,
    inputTokens: usage.totalInputTokens ?? usage.inputTokens,
    outputTokens: usage.outputTokens,
    contextTokens: usage.contextTokens,
    contextWindow: usage.contextWindow,
    generationMs: usage.generationMs ?? 0,
    compactions: options.compactions,
    relaunches: normalizeRelaunches(usage.relaunches),
    createdAt: options.at.toISOString(),
  };
}

function lastUsage(record: UsageRecord): TurnUsage {
  return {
    // L'entrée de la dernière étape n'est pas gardée : seule la jauge s'en sert,
    // et elle lit `contextTokens`.
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalInputTokens: record.inputTokens,
    steps: record.steps,
    generationMs: record.generationMs,
    ...(record.contextWindow !== undefined ? { contextWindow: record.contextWindow } : {}),
    ...(record.contextTokens !== undefined ? { contextTokens: record.contextTokens } : {}),
    ...(Object.keys(record.relaunches).length > 0 ? { relaunches: record.relaunches } : {}),
  };
}

function byTotalDesc(a: ModelUsageStats, b: ModelUsageStats): number {
  return (
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
    a.model.localeCompare(b.model)
  );
}

/** Agrégation de référence (version en mémoire ; la version SQL donne le même résultat). */
export function summarize(
  records: readonly UsageRecord[],
  period: UsagePeriod,
  now: Date = new Date(),
): UsageSummary {
  const start = periodStartDay(period, now);
  const inPeriod = records.filter((r) => start === undefined || r.day >= start);

  const models = new Map<string, UsageRecord[]>();
  for (const record of inPeriod) {
    const list = models.get(record.model);
    if (list) list.push(record);
    else models.set(record.model, [record]);
  }

  const stats = [...models].map(([model, list]): ModelUsageStats => {
    const sum = (pick: (r: UsageRecord) => number): number =>
      list.reduce((total, r) => total + pick(r), 0);
    const inputTokens = sum((r) => r.inputTokens);
    const outputTokens = sum((r) => r.outputTokens);
    const timed = list.filter((r) => r.generationMs > 0);
    const generationMs = timed.reduce((t, r) => t + r.generationMs, 0);
    const ratios = list.flatMap((r) =>
      r.contextTokens !== undefined && r.contextWindow !== undefined && r.contextWindow > 0
        ? [r.contextTokens / r.contextWindow]
        : [],
    );
    const relaunches: Partial<Record<RelaunchKind, number>> = {};
    for (const kind of RELAUNCH_KINDS) {
      const count = sum((r) => r.relaunches[kind] ?? 0);
      if (count > 0) relaunches[kind] = count;
    }
    return {
      model,
      turns: list.length,
      steps: sum((r) => r.steps),
      inputTokens,
      outputTokens,
      avgTokensPerTurn: (inputTokens + outputTokens) / list.length,
      ...(generationMs > 0
        ? { tokensPerSecond: (timed.reduce((t, r) => t + r.outputTokens, 0) / generationMs) * 1000 }
        : {}),
      ...(ratios.length > 0
        ? {
            avgContextRatio: ratios.reduce((t, r) => t + r, 0) / ratios.length,
            peakContextRatio: Math.max(...ratios),
          }
        : {}),
      compactions: sum((r) => r.compactions),
      relaunchedTurns: list.filter((r) => Object.keys(r.relaunches).length > 0).length,
      relaunches,
      errorTurns: list.filter((r) => r.outcome === 'error').length,
      lastUsedAt: list.reduce((last, r) => (r.createdAt > last ? r.createdAt : last), ''),
    };
  });

  const daily = new Map<string, UsageDailyPoint>();
  for (const record of inPeriod) {
    const key = `${record.day}\u0000${record.model}`;
    const point = daily.get(key) ?? {
      day: record.day,
      model: record.model,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
    };
    point.inputTokens += record.inputTokens;
    point.outputTokens += record.outputTokens;
    point.turns += 1;
    daily.set(key, point);
  }

  return {
    period,
    models: stats.sort(byTotalDesc),
    daily: [...daily.values()].sort(
      (a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model),
    ),
  };
}

export class InMemoryUsageStore implements UsageStore {
  readonly #records = new Map<string, UsageRecord>();

  record(record: UsageRecord): void {
    this.#records.set(record.turnId, {
      ...record,
      relaunches: normalizeRelaunches(record.relaunches),
    });
  }

  summary(period: UsagePeriod, now?: Date): UsageSummary {
    return summarize([...this.#records.values()], period, now);
  }

  lastForSession(sessionId: string): TurnUsage | undefined {
    const last = [...this.#records.values()]
      .filter((r) => r.sessionId === sessionId)
      .reduce<UsageRecord | undefined>(
        (latest, r) => (latest === undefined || r.createdAt >= latest.createdAt ? r : latest),
        undefined,
      );
    return last ? lastUsage(last) : undefined;
  }

  detachSession(sessionId: string): void {
    for (const [id, record] of this.#records) {
      if (record.sessionId === sessionId)
        this.#records.set(id, { ...record, sessionId: undefined });
    }
  }

  /** Tests : contenu brut. */
  all(): UsageRecord[] {
    return [...this.#records.values()];
  }
}

interface UsageRow {
  turn_id: string;
  session_id: string | null;
  model: string;
  outcome: TurnOutcome;
  day: string;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  context_tokens: number | null;
  context_window: number | null;
  generation_ms: number;
  compactions: number;
  relaunches: string;
  created_at: string;
}

function parseRelaunches(json: string): Partial<Record<RelaunchKind, number>> {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null ? normalizeRelaunches(value) : {};
  } catch {
    return {};
  }
}

function fromRow(row: UsageRow): UsageRecord {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id ?? undefined,
    model: row.model,
    outcome: row.outcome,
    day: row.day,
    steps: row.steps,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    contextTokens: row.context_tokens ?? undefined,
    contextWindow: row.context_window ?? undefined,
    generationMs: row.generation_ms,
    compactions: row.compactions,
    relaunches: parseRelaunches(row.relaunches),
    createdAt: row.created_at,
  };
}

interface ModelRow {
  model: string;
  turns: number;
  steps: number;
  input_tokens: number;
  output_tokens: number;
  timed_output: number;
  generation_ms: number;
  avg_ratio: number | null;
  peak_ratio: number | null;
  compactions: number;
  relaunched_turns: number;
  error_turns: number;
  last_used_at: string;
  [relaunch: `r_${string}`]: number | null;
}

/** Registre dans la base de l'historique (migration n° 2, voir `sqlite-store.ts`). */
export class SqliteUsageStore implements UsageStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  record(record: UsageRecord): void {
    this.#db
      .prepare(
        `INSERT INTO usage_turns (turn_id, session_id, model, outcome, day, steps, input_tokens,
           output_tokens, context_tokens, context_window, generation_ms, compactions, relaunches,
           created_at)
         VALUES (?, (SELECT id FROM sessions WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (turn_id) DO UPDATE SET
           session_id = excluded.session_id, model = excluded.model, outcome = excluded.outcome,
           day = excluded.day, steps = excluded.steps, input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens, context_tokens = excluded.context_tokens,
           context_window = excluded.context_window, generation_ms = excluded.generation_ms,
           compactions = excluded.compactions, relaunches = excluded.relaunches,
           created_at = excluded.created_at`,
      )
      .run(
        record.turnId,
        record.sessionId ?? null,
        record.model,
        record.outcome,
        record.day,
        record.steps,
        record.inputTokens,
        record.outputTokens,
        record.contextTokens ?? null,
        record.contextWindow ?? null,
        record.generationMs,
        record.compactions,
        JSON.stringify(normalizeRelaunches(record.relaunches)),
        record.createdAt,
      );
  }

  summary(period: UsagePeriod, now: Date = new Date()): UsageSummary {
    const start = periodStartDay(period, now) ?? '';
    const relaunchColumns = RELAUNCH_KINDS.map(
      (kind) => `SUM(json_extract(relaunches, '$.${kind}')) AS r_${kind}`,
    ).join(',\n           ');
    const rows = this.#db
      .prepare(
        `SELECT model,
           COUNT(*) AS turns,
           SUM(steps) AS steps,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(CASE WHEN generation_ms > 0 THEN output_tokens ELSE 0 END) AS timed_output,
           SUM(generation_ms) AS generation_ms,
           AVG(CASE WHEN context_window > 0 AND context_tokens IS NOT NULL
               THEN CAST(context_tokens AS REAL) / context_window END) AS avg_ratio,
           MAX(CASE WHEN context_window > 0 AND context_tokens IS NOT NULL
               THEN CAST(context_tokens AS REAL) / context_window END) AS peak_ratio,
           SUM(compactions) AS compactions,
           SUM(CASE WHEN relaunches <> '{}' THEN 1 ELSE 0 END) AS relaunched_turns,
           SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error_turns,
           MAX(created_at) AS last_used_at,
           ${relaunchColumns}
         FROM usage_turns
         WHERE day >= ?
         GROUP BY model`,
      )
      .all(start) as unknown as ModelRow[];

    const models = rows.map((row): ModelUsageStats => {
      const relaunches: Partial<Record<RelaunchKind, number>> = {};
      for (const kind of RELAUNCH_KINDS) {
        const count = row[`r_${kind}`];
        if (typeof count === 'number' && count > 0) relaunches[kind] = count;
      }
      return {
        model: row.model,
        turns: row.turns,
        steps: row.steps,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        avgTokensPerTurn: (row.input_tokens + row.output_tokens) / row.turns,
        ...(row.generation_ms > 0
          ? { tokensPerSecond: (row.timed_output / row.generation_ms) * 1000 }
          : {}),
        ...(row.avg_ratio !== null && row.peak_ratio !== null
          ? { avgContextRatio: row.avg_ratio, peakContextRatio: row.peak_ratio }
          : {}),
        compactions: row.compactions,
        relaunchedTurns: row.relaunched_turns,
        relaunches,
        errorTurns: row.error_turns,
        lastUsedAt: row.last_used_at,
      };
    });

    const daily = this.#db
      .prepare(
        `SELECT day, model, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
           COUNT(*) AS turns
         FROM usage_turns
         WHERE day >= ?
         GROUP BY day, model
         ORDER BY day, model`,
      )
      .all(start) as unknown as UsageDailyPoint[];

    return {
      period,
      models: models.sort(byTotalDesc),
      daily: daily.map((p) => ({ ...p })),
    };
  }

  lastForSession(sessionId: string): TurnUsage | undefined {
    const row = this.#db
      .prepare(
        'SELECT * FROM usage_turns WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(sessionId) as UsageRow | undefined;
    return row ? lastUsage(fromRow(row)) : undefined;
  }

  detachSession(): void {
    // Rien à faire : `ON DELETE SET NULL` sur la clé étrangère.
  }

  /** Tests : contenu brut. */
  all(): UsageRecord[] {
    return (
      this.#db.prepare('SELECT * FROM usage_turns ORDER BY rowid').all() as unknown as UsageRow[]
    ).map(fromRow);
  }
}
