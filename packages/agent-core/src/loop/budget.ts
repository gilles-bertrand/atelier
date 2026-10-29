/**
 * Budget de contexte par étape : borne la taille des résultats d'outils injectés
 * dans l'historique en fonction de la fenêtre de contexte.
 *
 * La fenêtre (`num_ctx` de `/api/show` ou réglage `numCtx`) est un plafond, pas
 * une garantie : certains runners (Ollama MLX) l'ignorent et acceptent des
 * prompts bien plus longs, au prix de minutes de préremplissage. La borne est
 * donc appliquée côté app, avant l'envoi.
 */

/** Part max de la fenêtre pour une seule sortie d'outil. */
export const TOOL_OUTPUT_SHARE = 0.25;
/** Part max de la fenêtre pour la somme des sorties d'outils d'une étape. */
export const STEP_OUTPUT_SHARE = 0.5;
/** Part plancher du budget d'une étape, même quand la fenêtre est déjà bien remplie. */
export const STEP_OUTPUT_FLOOR_SHARE = 0.1;
/** Remplissage visé de la fenêtre (le reste est laissé à la réponse). */
export const TARGET_FILL_SHARE = 0.9;
/** Taille minimale d'une sortie, même budget épuisé (le modèle doit voir un début). */
export const MIN_TOOL_OUTPUT_TOKENS = 200;

/**
 * Estimation prudente du nombre de tokens (tokenizer Qwen) sans tokenizer :
 * chaque chiffre et chaque signe de ponctuation compte pour un token, les
 * lettres pour un quart, les blancs pour un tiers. Mesuré sur Qwen 3.5 :
 * prose française et code surestimés de 15 à 40 %, CSV numérotés à ±5 %
 * (les chiffres y sont découpés un par un : ~1,4 caractère par token).
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  let inSpace = false;
  for (const char of text) {
    if (/\s/u.test(char)) {
      if (!inSpace) tokens += 0.3;
      inSpace = true;
      continue;
    }
    inSpace = false;
    if (/\p{L}/u.test(char)) tokens += 0.25;
    else tokens += 1;
  }
  return Math.ceil(tokens);
}

/** Résultat de {@link truncateToTokens}. */
export interface TruncatedText {
  text: string;
  truncated: boolean;
  /** Tokens estimés du texte conservé. */
  tokens: number;
  /** Lignes de la sortie gardées (entières ou non) et lignes au total. */
  keptLines: number;
  totalLines: number;
  /** Numéro de la dernière ligne gardée si la sortie est numérotée (`     12\t…`). */
  lastLineNumber?: number;
}

const NUMBERED_LINE = /^\s*(\d+)\t/;

/** Garde le début de `text` dans la limite de `maxTokens` (coupe en fin de ligne si possible). */
export function truncateToTokens(text: string, maxTokens: number): TruncatedText {
  const total = estimateTokens(text);
  const lines = text.split('\n');
  if (total <= maxTokens) {
    return {
      text,
      truncated: false,
      tokens: total,
      keptLines: lines.length,
      totalLines: lines.length,
    };
  }
  const kept: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > maxTokens) {
      if (kept.length === 0) {
        // Une seule ligne trop longue : coupe proportionnelle.
        const chars = Math.max(1, Math.floor((line.length * (maxTokens - tokens)) / cost));
        kept.push(line.slice(0, chars));
        tokens = maxTokens;
      }
      break;
    }
    kept.push(line);
    tokens += cost;
  }
  const lastKept = kept.at(-1) ?? '';
  const match = NUMBERED_LINE.exec(lastKept);
  return {
    text: kept.join('\n'),
    truncated: true,
    tokens,
    keptLines: kept.length,
    totalLines: lines.length,
    ...(match?.[1] !== undefined ? { lastLineNumber: Number(match[1]) } : {}),
  };
}

/** Note ajoutée à une sortie tronquée : dit au modèle comment lire la suite. */
export function truncationNotice(info: {
  toolName: string;
  keptTokens: number;
  totalTokens: number;
  keptLines: number;
  totalLines: number;
  lastLineNumber?: number;
}): string {
  const resume =
    info.lastLineNumber !== undefined
      ? ` Suite à partir de la ligne ${info.lastLineNumber + 1} (offset: ${info.lastLineNumber + 1}).`
      : '';
  return `[Atelier : sortie de ${info.toolName} tronquée pour tenir dans la fenêtre de contexte : ${info.keptLines} lignes affichées sur ${info.totalLines} (≈ ${info.keptTokens} tokens sur ≈ ${info.totalTokens}).${resume} Ne relis pas tout d'un bloc : lis une autre partie avec offset/limit, cherche avec grep, ou calcule sur le fichier entier avec un script (bash, Python) dans la machine isolée si elle est disponible.]`;
}

/** Budget des sorties d'outils d'un tour, réinitialisé à chaque étape. */
export class ToolOutputBudget {
  readonly #contextWindow: number;
  #stepLimit: number;
  #used = 0;

  constructor(contextWindow: number) {
    this.#contextWindow = Math.max(1, contextWindow);
    this.#stepLimit = this.#share(STEP_OUTPUT_SHARE);
  }

  #share(share: number): number {
    return Math.floor(this.#contextWindow * share);
  }

  /** Tokens de sorties d'outils (estimés) ajoutés pendant l'étape courante. */
  get usedThisStep(): number {
    return this.#used;
  }

  /** Budget total de l'étape courante. */
  get stepLimit(): number {
    return this.#stepLimit;
  }

  /**
   * Nouvelle étape. `contextTokens` = taille estimée de la requête qui va
   * partir (sans les sorties de cette étape) : le budget de l'étape est la place
   * restante jusqu'à {@link TARGET_FILL_SHARE} de la fenêtre, entre un plancher
   * ({@link STEP_OUTPUT_FLOOR_SHARE}, la compaction suivante fera de la place)
   * et un plafond ({@link STEP_OUTPUT_SHARE}).
   */
  startStep(contextTokens?: number): void {
    this.#used = 0;
    const max = this.#share(STEP_OUTPUT_SHARE);
    if (contextTokens === undefined) {
      this.#stepLimit = max;
      return;
    }
    const room = this.#share(TARGET_FILL_SHARE) - contextTokens;
    this.#stepLimit = Math.min(max, Math.max(this.#share(STEP_OUTPUT_FLOOR_SHARE), room));
  }

  /** Borne `content` au budget restant de l'étape et l'imputer. */
  fit(toolName: string, content: string): { content: string; truncated: boolean } {
    const perOutput = this.#share(TOOL_OUTPUT_SHARE);
    const remaining = this.#stepLimit - this.#used;
    const limit = Math.max(MIN_TOOL_OUTPUT_TOKENS, Math.min(perOutput, remaining));
    const cut = truncateToTokens(content, limit);
    if (!cut.truncated) {
      this.#used += cut.tokens;
      return { content, truncated: false };
    }
    const notice = truncationNotice({
      toolName,
      keptTokens: cut.tokens,
      totalTokens: estimateTokens(content),
      keptLines: cut.keptLines,
      totalLines: cut.totalLines,
      ...(cut.lastLineNumber !== undefined ? { lastLineNumber: cut.lastLineNumber } : {}),
    });
    this.#used += cut.tokens + estimateTokens(notice);
    return { content: `${cut.text}\n${notice}`, truncated: true };
  }
}
