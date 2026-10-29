/**
 * Garde-fou bon marché contre les montants inventés dans la réponse finale
 * (#61) : un montant cité doit figurer dans les données du tour (sorties
 * d'outils, appels d'outils comme le contenu d'un fichier écrit, messages de
 * l'utilisateur). Pas d'appel au modèle : simple comparaison de nombres.
 */
import type { ModelMessage } from 'ai';
import { APP_MESSAGE_PREFIX } from './compaction.js';

/** En dessous, un nombre n'est pas vérifié (quantités, pourcentages, jours…). */
export const MIN_CHECKED_AMOUNT = 1_000;

// Groupes de milliers séparés par espace / espace insécable / espace fine, ou
// par virgule / point ; partie décimale optionnelle.
const NUMBER = /\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d{3})*(?:[.,]\d+)?/g;

/** Interprétations possibles d'un nombre écrit (formats français et anglais). */
export function numberValues(raw: string): number[] {
  const compact = raw.replace(/[ \u00a0\u202f]/g, '');
  const values = new Set<number>();
  const add = (text: string): void => {
    const value = Number(text);
    if (Number.isFinite(value)) values.add(value);
  };
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  if (lastComma === -1 && lastDot === -1) {
    add(compact);
  } else {
    // Le dernier séparateur peut être décimal…
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    add(compact.split(thousandSep).join('').replace(decimalSep, '.'));
    // … ou un séparateur de milliers (« 1,234 », « 89.237 »).
    add(compact.replace(/[.,]/g, ''));
  }
  return [...values];
}

/** Nombres d'un texte, avec toutes leurs interprétations. */
export function extractNumbers(text: string): { raw: string; values: number[] }[] {
  return [...text.matchAll(NUMBER)].map((m) => ({ raw: m[0], values: numberValues(m[0]) }));
}

function isYear(value: number): boolean {
  return Number.isInteger(value) && value >= 1900 && value <= 2100;
}

/** Montant à vérifier : au moins {@link MIN_CHECKED_AMOUNT}, et pas une année. */
function isCheckedAmount(values: readonly number[]): boolean {
  return values.some((v) => Math.abs(v) >= MIN_CHECKED_AMOUNT && !isYear(v));
}

/** Vrai si `cited` correspond à `source`, éventuellement arrondi (0, 1 ou 2 décimales). */
function matches(cited: number, source: number): boolean {
  if (Math.abs(cited - source) < 0.005) return true;
  return [0, 1, 2].some((d) => Math.abs(cited - Number(source.toFixed(d))) < 0.005);
}

/** Texte des données du tour : sorties et appels d'outils, messages utilisateur. */
export function sourceText(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (message.role === 'user') parts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text' && message.role === 'user') parts.push(part.text);
      else if (part.type === 'tool-call') parts.push(JSON.stringify(part.input));
      else if (part.type === 'tool-result') {
        const out = part.output;
        parts.push(
          out.type === 'text' || out.type === 'error-text'
            ? out.value
            : JSON.stringify('value' in out ? out.value : out),
        );
      }
    }
  }
  return parts.join('\n');
}

/**
 * Montants cités dans `answer` absents des données du tour (`sources`).
 * Renvoie les écritures telles qu'elles apparaissent dans la réponse.
 */
export function unverifiedAmounts(answer: string, sources: string): string[] {
  const known = extractNumbers(sources).flatMap((n) => n.values);
  const missing: string[] = [];
  for (const { raw, values } of extractNumbers(answer)) {
    if (!isCheckedAmount(values)) continue;
    if (values.some((v) => known.some((s) => matches(v, s)))) continue;
    if (!missing.includes(raw)) missing.push(raw);
  }
  return missing;
}

/** Message de relance (injecté) quand la réponse cite des montants non vérifiés. */
export function verificationPrompt(amounts: readonly string[]): string {
  return `${APP_MESSAGE_PREFIX} Vérification : ta réponse cite ${amounts.map((a) => `« ${a} »`).join(', ')}, qui n'apparai${amounts.length > 1 ? 'ssent' : 't'} dans aucun résultat d'outil ni dans aucun fichier écrit pendant ce tour. Vérifie ces chiffres (relis le fichier produit ou recalcule), puis redonne ta réponse finale en ne citant que des chiffres vérifiés ; sinon, renvoie simplement au fichier.`;
}
