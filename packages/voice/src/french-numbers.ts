/**
 * Nombres en toutes lettres, en français (ADR-004 D7, filtre « prononçable »).
 *
 * Code maison, sans dépendance : orthographe traditionnelle (trait d'union entre
 * dizaines et unités sous cent, « et » dans 21, 31… 71), accords de « cent » et
 * de « vingt » (« quatre-vingts », « deux cents », mais « deux cent mille »),
 * « mille » invariable, « million » et « milliard » au pluriel. Le genre
 * féminin ne change que le « un » final (« vingt et une heures »).
 */

const UNITS = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'dix-sept',
  'dix-huit',
  'dix-neuf',
] as const;

const TENS = [
  '',
  '',
  'vingt',
  'trente',
  'quarante',
  'cinquante',
  'soixante',
  'soixante',
  'quatre-vingt',
  'quatre-vingt',
] as const;

/** Plus grand entier lu en toutes lettres ; au-delà, chiffre par chiffre. */
export const MAX_SPOKEN_INTEGER = 999_999_999_999;

export interface FrenchNumberOptions {
  /** Accord au féminin du « un » final (« une heure », « vingt et une secondes »). */
  feminine?: boolean;
}

/** De 0 à 99. `final` : dernier mot du nombre (accord de « quatre-vingts »). */
function below100(n: number, final: boolean): string {
  if (n < 20) return UNITS[n] ?? '';
  const ten = Math.floor(n / 10);
  const unit = n % 10;
  const base = TENS[ten] ?? '';
  // 70 à 79 et 90 à 99 : « soixante-dix », « quatre-vingt-onze ».
  if (ten === 7 || ten === 9) {
    const rest = 10 + unit;
    if (ten === 7 && unit === 1) return 'soixante et onze';
    return `${base}-${UNITS[rest] ?? ''}`;
  }
  if (unit === 0) return ten === 8 && final ? 'quatre-vingts' : base;
  if (unit === 1 && ten !== 8) return `${base} et un`;
  return `${base}-${UNITS[unit] ?? ''}`;
}

/** De 0 à 999. `final` : rien ne suit (accord de « cents » et « vingts »). */
function below1000(n: number, final: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return below100(rest, final);
  const head = hundreds === 1 ? 'cent' : `${UNITS[hundreds] ?? ''} cent`;
  if (rest === 0) return hundreds > 1 && final ? `${head}s` : head;
  return `${head} ${below100(rest, final)}`;
}

/** Met au féminin le « un » final d'un nombre écrit (« vingt et un » → « vingt et une »). */
function feminize(words: string): string {
  return words.replace(/(^|[\s-])un$/u, '$1une');
}

/**
 * Entier positif ou nul en toutes lettres. Au-delà de {@link MAX_SPOKEN_INTEGER}
 * (ou pour un entier non sûr), les chiffres sont lus un par un.
 */
export function integerToFrench(value: number, options: FrenchNumberOptions = {}): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SPOKEN_INTEGER) {
    return digitsToFrench(String(value).replace(/\D/gu, ''));
  }
  if (value === 0) return 'zéro';
  const billions = Math.floor(value / 1_000_000_000);
  const millions = Math.floor(value / 1_000_000) % 1000;
  const thousands = Math.floor(value / 1000) % 1000;
  const rest = value % 1000;
  const parts: string[] = [];
  // « Million » et « milliard » sont des noms : « deux cents millions ».
  if (billions > 0) {
    parts.push(`${below1000(billions, true)} milliard${billions > 1 ? 's' : ''}`);
  }
  if (millions > 0) {
    parts.push(`${below1000(millions, true)} million${millions > 1 ? 's' : ''}`);
  }
  // « Mille » est invariable, et « cent », « vingt » ne s'accordent pas devant lui.
  if (thousands > 0) parts.push(thousands === 1 ? 'mille' : `${below1000(thousands, false)} mille`);
  if (rest > 0) parts.push(below1000(rest, true));
  const words = parts.join(' ');
  return options.feminine === true && rest > 0 ? feminize(words) : words;
}

/** Chiffres lus un par un (« 0 4 » → « zéro quatre »). */
export function digitsToFrench(digits: string): string {
  return Array.from(digits.matchAll(/\d/gu), (m) => UNITS[Number(m[0])] ?? '').join(' ');
}

/**
 * Suite de chiffres telle qu'écrite : les zéros de tête sont lus (« 05 » →
 * « zéro cinq »), le reste comme un entier.
 */
export function digitStringToFrench(digits: string, options: FrenchNumberOptions = {}): string {
  const lead = /^0+/u.exec(digits)?.[0] ?? '';
  const rest = digits.slice(lead.length);
  if (rest === '') return digitsToFrench(digits);
  if (rest.length > 12) return digitsToFrench(digits);
  const words = integerToFrench(Number(rest), options);
  return lead === '' ? words : `${digitsToFrench(lead)} ${words}`;
}

/**
 * Nombre écrit à la française : partie entière et partie décimale séparées par
 * une virgule (« 3,5 » → « trois virgule cinq »). `fraction` garde ses zéros de
 * tête (« 3,05 » → « trois virgule zéro cinq »).
 */
export function decimalToFrench(
  integer: string,
  fraction: string | undefined,
  options: FrenchNumberOptions = {},
): string {
  const whole = digitStringToFrench(integer === '' ? '0' : integer, fraction ? {} : options);
  if (fraction === undefined || fraction === '') return whole;
  return `${whole} virgule ${digitStringToFrench(fraction, options)}`;
}

const ORDINAL_SPECIAL: Readonly<Record<string, string>> = {
  un: 'unième',
  cinq: 'cinquième',
  neuf: 'neuvième',
};

/** Ordinal : 1 → « premier » (« première »), 2 → « deuxième », 21 → « vingt et unième ». */
export function ordinalToFrench(value: number, feminine = false): string {
  if (value === 1) return feminine ? 'première' : 'premier';
  const words = integerToFrench(value);
  const match = /([a-zé]+)$/u.exec(words);
  const last = match?.[1] ?? '';
  const head = words.slice(0, words.length - last.length);
  const special = ORDINAL_SPECIAL[last];
  if (special !== undefined) return `${head}${special}`;
  // « quatre » → « quatrième », « onze » → « onzième », « cents » → « centième ».
  const stem = last.replace(/^(cent|vingt|million|milliard)s$/u, '$1').replace(/e$/u, '');
  return `${head}${stem}ième`;
}

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

/** Nom du mois (1 à 12), ou `undefined`. */
export function monthName(month: number): string | undefined {
  return MONTHS[month - 1];
}

/** Jour du mois lu à la française : « premier », puis « deux », « trois »… */
export function dayToFrench(day: number): string {
  return day === 1 ? 'premier' : integerToFrench(day);
}

/** Date complète : « 10 novembre 2026 » → « dix novembre deux mille vingt-six ». */
export function dateToFrench(day: number, month: number, year?: number): string | undefined {
  const name = monthName(month);
  if (name === undefined || day < 1 || day > 31) return undefined;
  const head = `${dayToFrench(day)} ${name}`;
  return year === undefined ? head : `${head} ${integerToFrench(year)}`;
}

/** Heure : « 14h30 » → « quatorze heures trente », « 1h » → « une heure ». */
export function timeToFrench(hours: number, minutes = 0): string {
  const h = `${integerToFrench(hours, { feminine: true })} heure${hours > 1 ? 's' : ''}`;
  if (minutes === 0) return h;
  return `${h} ${integerToFrench(minutes, { feminine: true })}`;
}
