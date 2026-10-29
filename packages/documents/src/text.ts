/** Mise en forme du texte renvoyé au modèle : lignes numérotées, fenêtre offset/limit. */
import { estimateTokens } from '@atelier/agent-core';

/** Nombre maximal de lignes renvoyées par appel. */
export const MAX_LINES = 2000;
/** Longueur maximale d'une ligne (au-delà, elle est coupée). */
export const MAX_LINE_CHARS = 2000;
/**
 * Part de la fenêtre de contexte visée pour une sortie de `read_file` : 20 %,
 * pour garder une marge sous le plafond de 25 % qu'agent-core applique à toute
 * sortie d'outil (`TOOL_OUTPUT_SHARE`, coupe par la fin). Ainsi la consigne de
 * continuation, placée en fin de sortie, n'est jamais coupée.
 */
export const OUTPUT_SHARE = 0.2;
/** Fenêtre de contexte de référence (Modelfile `atelier`). */
const DEFAULT_CONTEXT_WINDOW = 32_768;
/** Budget minimal d'une sortie, en tokens estimés. */
const MIN_OUTPUT_TOKENS = 500;

/**
 * Budget de sortie d'un appel de `read_file`, en tokens estimés
 * (`estimateTokens` d'agent-core), dérivé de la fenêtre de contexte.
 */
export function outputTokensForContext(contextWindowTokens: number, share = OUTPUT_SHARE): number {
  return Math.max(MIN_OUTPUT_TOKENS, Math.floor(contextWindowTokens * share));
}

/** Budget par défaut : 20 % d'une fenêtre de 32 768 tokens (6 553 tokens estimés). */
export const MAX_OUTPUT_TOKENS = outputTokensForContext(DEFAULT_CONTEXT_WINDOW);

/**
 * Tokens réservés à l'en-tête et à la consigne de fin : le corps d'une sortie
 * dispose du budget moins cette réserve.
 */
export const FRAME_RESERVE_TOKENS = 300;

/** Budget du corps d'une sortie (budget total moins la réserve d'en-tête et de fin). */
export function bodyBudget(maxTokens: number): number {
  return Math.max(MIN_OUTPUT_TOKENS - FRAME_RESERVE_TOKENS, maxTokens - FRAME_RESERVE_TOKENS);
}

/** Fenêtre de lignes demandée. */
export interface LineWindow {
  /** Première ligne (1 = début). */
  offset?: number;
  /** Nombre de lignes. */
  limit?: number;
}

/** Résultat de la mise en forme. */
export interface WindowedText {
  /** Corps (lignes numérotées ou non). */
  body: string;
  /** Première ligne renvoyée (1-based). */
  first: number;
  /** Dernière ligne renvoyée (1-based ; `first - 1` si aucune). */
  last: number;
  /** Nombre total de lignes. */
  total: number;
}

/** Découpe en lignes (CRLF et CR acceptés ; pas de ligne vide fantôme en fin). */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [ligne tronquée]` : line;
}

/**
 * Sélectionne la fenêtre `offset`/`limit` (2000 lignes et `maxTokens` tokens
 * estimés au plus pour le corps) et numérote les lignes si demandé (format
 * `     12\ttexte`).
 */
export function windowLines(
  text: string,
  window: LineWindow,
  numbered: boolean,
  maxTokens = bodyBudget(MAX_OUTPUT_TOKENS),
): WindowedText {
  const lines = splitLines(text);
  const total = lines.length;
  const start = Math.max(1, window.offset ?? 1);
  const limit = Math.min(window.limit ?? MAX_LINES, MAX_LINES);
  const out: string[] = [];
  let tokens = 0;
  let last = start - 1;
  for (let n = start; n <= total && n < start + limit; n++) {
    const raw = clip(lines[n - 1] ?? '');
    const line = numbered ? `${String(n).padStart(6)}\t${raw}` : raw;
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > maxTokens && out.length > 0) break;
    out.push(line);
    tokens += cost;
    last = n;
  }
  return { body: out.join('\n'), first: start, last, total };
}

/** En-tête indiquant la fenêtre renvoyée et comment lire la suite. */
export function windowHeader(window: WindowedText, unit = 'lignes'): string {
  if (window.total === 0) return '';
  if (window.last < window.first) {
    return `[${unit} : le fichier en compte ${window.total}, offset ${window.first} est au-delà de la fin]`;
  }
  if (window.first === 1 && window.last === window.total) return '';
  const more = window.last < window.total ? ` ; suite avec offset: ${window.last + 1}` : '';
  return `[${unit} ${window.first}-${window.last} sur ${window.total}${more}]`;
}
