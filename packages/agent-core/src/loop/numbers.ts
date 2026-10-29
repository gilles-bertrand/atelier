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

/** Début de la première ligne de la réponse donnée après une vérification. */
export const CORRECTION_PREFIX = 'Correction :';

// Groupes de milliers séparés par espace / espace insécable / espace fine, ou
// par virgule / point ; partie décimale optionnelle.
const NUMBER = /\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d{3})*(?:[.,]\d+)?/g;

/** Vrai si chaque groupe qui suit un `sep` compte exactement 3 chiffres. */
function thousandGroups(text: string, sep: string): boolean {
  return text
    .split(sep)
    .slice(1)
    .every((group) => /^\d{3}$/.test(group));
}

/**
 * Interprétations possibles d'un nombre écrit (formats français et anglais).
 * Un point ou une virgule n'est un séparateur de milliers que s'il est suivi
 * d'exactement 3 chiffres : « 25,94 » ne vaut que 25,94 ; « 1,234 » reste
 * ambigu (1,234 ou 1 234).
 */
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
    return [...values];
  }
  // Le dernier séparateur est décimal : la partie entière n'a que des séparateurs
  // de milliers (l'autre signe), chacun suivi de 3 chiffres.
  const decimalSep = lastComma > lastDot ? ',' : '.';
  const thousandSep = decimalSep === ',' ? '.' : ',';
  const cut = compact.lastIndexOf(decimalSep);
  const integer = compact.slice(0, cut);
  if (!integer.includes(decimalSep) && thousandGroups(integer, thousandSep)) {
    add(`${integer.split(thousandSep).join('')}.${compact.slice(cut + 1)}`);
  }
  // Ou tous les séparateurs sont des milliers (« 1,234 », « 89.237 », « 1.234.567 ») :
  // un seul signe, chaque groupe de 3 chiffres.
  const signs = new Set(compact.replace(/\d/g, ''));
  if (signs.size === 1 && thousandGroups(compact, decimalSep)) {
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

/** Clé de comparaison : le montant en centimes. */
function cents(value: number): number {
  return Math.round(value * 100);
}

/**
 * Index des nombres des sources, en centimes, avec leurs arrondis à 0, 1 et
 * 2 décimales : un montant cité correspond s'il en est un arrondi. Recherche
 * en temps constant, même sur la sortie d'un long document.
 */
function knownAmounts(sources: string): Set<number> {
  const known = new Set<number>();
  for (const { values } of extractNumbers(sources)) {
    for (const value of values) {
      known.add(cents(value));
      for (const digits of [0, 1]) known.add(cents(Number(value.toFixed(digits))));
    }
  }
  return known;
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
  const known = knownAmounts(sources);
  const missing: string[] = [];
  for (const { raw, values } of extractNumbers(answer)) {
    if (!isCheckedAmount(values)) continue;
    if (values.some((v) => known.has(cents(v)))) continue;
    if (!missing.includes(raw)) missing.push(raw);
  }
  return missing;
}

/**
 * Message de relance (injecté) quand la réponse cite des montants non vérifiés.
 * La réponse fautive est déjà affichée : la nouvelle commence par une ligne
 * « Correction : … » pour que l'utilisateur sache laquelle croire.
 */
export function verificationPrompt(amounts: readonly string[]): string {
  const cited = amounts.map((a) => `« ${a} »`).join(', ');
  const verb = amounts.length > 1 ? 'apparaissent' : 'apparaît';
  return `${APP_MESSAGE_PREFIX} Vérification : ta réponse cite ${cited}, qui n'${verb} dans aucun résultat d'outil ni dans aucun fichier écrit pendant ce tour. L'utilisateur a déjà vu cette réponse. Vérifie ces chiffres (relis le fichier produit ou recalcule avec un outil), puis commence ta nouvelle réponse par une ligne « ${CORRECTION_PREFIX} … » qui donne le chiffre vérifié à la place du chiffre erroné (ou, si le chiffre était juste, qui le confirme en citant sa source). Redonne ensuite ta réponse finale en ne citant que des chiffres vérifiés ; si tu ne peux pas vérifier, dis-le dans la ligne de correction et renvoie au fichier.`;
}
