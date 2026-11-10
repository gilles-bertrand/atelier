/**
 * Filtre « prononçable » en français (ADR-004 D7, L7) : ce que la synthèse
 * reçoit, phrase par phrase, à partir du texte de l'agent.
 *
 * - Retire le markdown (titres, listes, emphase, liens, code), les URL, les
 *   emoji ; un chemin complet se réduit au nom du fichier (« ventes point csv »).
 * - Écrit en toutes lettres les nombres, montants, pourcentages, dates, heures,
 *   ordinaux et unités (« 12,50 € » → « douze euros cinquante »).
 *
 * Les blocs (code entre ```, tableaux, filets) sont retirés par le découpeur
 * ({@link SpeechChunker}) ou par {@link speakableFrench}, qui voient les lignes
 * entières. Fonctions pures, sans dépendance : aucun phonémiseur (GPL exclu,
 * ADR-004 D5). Le texte n'est jamais journalisé.
 */
import {
  dateToFrench,
  decimalToFrench,
  digitStringToFrench,
  integerToFrench,
  ordinalToFrench,
  timeToFrench,
  type FrenchNumberOptions,
} from './french-numbers.js';

// --- Lignes : préfixes et blocs ---------------------------------------------

/** Ligne qui ouvre ou ferme un bloc de code (```, ~~~). */
export function isFenceLine(line: string): boolean {
  return /^\s{0,3}(?:```|~~~)/u.test(line);
}

/** Ligne de tableau markdown (`| a | b |`) ou ligne de séparation (`---|---`). */
export function isTableLine(line: string): boolean {
  return /^\s*\|/u.test(line) || /^\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/u.test(line);
}

/** Filet horizontal (`---`, `***`, `___`). */
export function isRuleLine(line: string): boolean {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line);
}

/** Préfixes markdown d'une ligne : titres, citations, puces, numéros, cases à cocher. */
const LINE_PREFIX = /^\s*(?:(?:#{1,6}|>|[-*+•‣◦▪]|\d{1,3}[.)]|\[[ xX]\])\s+)+/u;

/** Retire les préfixes markdown d'une ligne complète. */
export function stripLinePrefix(line: string): string {
  return line.replace(LINE_PREFIX, '');
}

/**
 * Début de ligne encore incomplet qui pourrait n'être qu'un préfixe, une
 * clôture de code ou un filet : le découpeur attend la suite avant de parler.
 */
export function isPendingLineStart(text: string): boolean {
  // Sans quantificateurs imbriqués : temps linéaire, même sur une longue ligne de tirets.
  return /^[\s#>*+•‣◦▪_~`|-]*(?:\d{1,3}[.)]?\s*)?(?:\[[ xX]?\]?)?$/u.test(text);
}

// --- Nombres ---------------------------------------------------------------

/** Nombre écrit : groupes de milliers séparés par une espace, ou chiffres, décimales éventuelles. */
const NUM = String.raw`\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
/** Pas de chiffre ni de lettre juste avant. */
const BEFORE = String.raw`(?<![\p{L}\d])`;
/** Pas de chiffre ni de lettre juste après. */
const AFTER = String.raw`(?![\p{L}\d])`;

/** Nombre écrit (« 1 234,5 », « 3.5 ») en toutes lettres ; la virgule se lit « virgule », le point « point ». */
export function numberToFrench(raw: string, options: FrenchNumberOptions = {}): string {
  const compact = raw.replace(/ /gu, '');
  const match = /^(\d+)(?:([.,])(\d+))?$/u.exec(compact);
  if (match === null) return raw;
  const [, integer = '', separator, fraction] = match;
  if (separator === '.' && fraction !== undefined) {
    return `${digitStringToFrench(integer)} point ${digitStringToFrench(fraction, options)}`;
  }
  return decimalToFrench(integer, fraction, options);
}

/** Valeur numérique d'un nombre écrit (« 1 234,5 » → 1234.5). */
function numericValue(raw: string): number {
  return Number(raw.replace(/ /gu, '').replace(',', '.'));
}

/** Singulier jusqu'à 2 exclus (« 1,5 kilomètre »), pluriel au-delà. */
function isPlural(raw: string): boolean {
  return Math.abs(numericValue(raw)) >= 2;
}

// --- Montants --------------------------------------------------------------

interface Currency {
  one: string;
  many: string;
  centOne: string;
  centMany: string;
  feminine: boolean;
  /** « d'euros », « de dollars » après « million » ou « milliard ». */
  of: string;
}

const EURO: Currency = {
  one: 'euro',
  many: 'euros',
  centOne: 'centime',
  centMany: 'centimes',
  feminine: false,
  of: 'd’euros',
};
const CURRENCIES: Readonly<Record<string, Currency>> = {
  '€': EURO,
  EUR: EURO,
  $: {
    one: 'dollar',
    many: 'dollars',
    centOne: 'cent',
    centMany: 'cents',
    feminine: false,
    of: 'de dollars',
  },
  USD: {
    one: 'dollar',
    many: 'dollars',
    centOne: 'cent',
    centMany: 'cents',
    feminine: false,
    of: 'de dollars',
  },
  '£': {
    one: 'livre',
    many: 'livres',
    centOne: 'penny',
    centMany: 'pence',
    feminine: true,
    of: 'de livres',
  },
  GBP: {
    one: 'livre',
    many: 'livres',
    centOne: 'penny',
    centMany: 'pence',
    feminine: true,
    of: 'de livres',
  },
  CHF: {
    one: 'franc suisse',
    many: 'francs suisses',
    centOne: 'centime',
    centMany: 'centimes',
    feminine: false,
    of: 'de francs suisses',
  },
};

const SCALES: Readonly<Record<string, { factor: number; one: string; many: string }>> = {
  k: { factor: 1_000, one: 'mille', many: 'mille' },
  K: { factor: 1_000, one: 'mille', many: 'mille' },
  M: { factor: 1_000_000, one: 'million', many: 'millions' },
  Md: { factor: 1_000_000_000, one: 'milliard', many: 'milliards' },
  Mds: { factor: 1_000_000_000, one: 'milliard', many: 'milliards' },
  Mrd: { factor: 1_000_000_000, one: 'milliard', many: 'milliards' },
};

/** Montant en toutes lettres : « 12,50 € » → « douze euros cinquante ». */
export function amountToFrench(raw: string, currencyKey: string, scaleKey?: string): string {
  const currency = CURRENCIES[currencyKey] ?? EURO;
  const g = { feminine: currency.feminine };
  const compact = raw.replace(/ /gu, '');
  const [integer = '0', fraction] = compact.split(/[.,]/u);
  const scale = scaleKey === undefined ? undefined : SCALES[scaleKey];
  if (scale !== undefined) {
    const value = numericValue(raw) * scale.factor;
    // « 1,2 k€ » → « mille deux cents euros » ; « 2,5 M€ » → « deux virgule cinq millions d'euros ».
    if (scale.factor === 1_000 && Number.isSafeInteger(value)) {
      return `${integerToFrench(value, g)} ${value >= 2 ? currency.many : currency.one}`;
    }
    const plural = numericValue(raw) >= 2;
    return `${decimalToFrench(integer, fraction, g)} ${plural ? scale.many : scale.one} ${currency.of}`;
  }
  if (fraction !== undefined && fraction.length > 2) {
    return `${decimalToFrench(integer, fraction)} ${isPlural(raw) ? currency.many : currency.one}`;
  }
  const units = Number(integer);
  const cents = fraction === undefined ? 0 : Number(fraction.padEnd(2, '0'));
  const unitWords = digitStringToFrench(integer, g);
  const name = /milli(?:on|ard)s?$/u.test(unitWords)
    ? currency.of
    : units >= 2
      ? currency.many
      : currency.one;
  if (cents === 0) return `${unitWords} ${name}`;
  const centWords = integerToFrench(cents);
  if (units === 0) return `${centWords} ${cents >= 2 ? currency.centMany : currency.centOne}`;
  return `${unitWords} ${name} ${centWords}`;
}

// --- Unités ----------------------------------------------------------------

interface Unit {
  one: string;
  many: string;
  feminine?: boolean;
}

const UNITS: Readonly<Record<string, Unit>> = {
  'km/h': { one: 'kilomètre par heure', many: 'kilomètres par heure' },
  'Mbit/s': { one: 'mégabit par seconde', many: 'mégabits par seconde' },
  'Mb/s': { one: 'mégabit par seconde', many: 'mégabits par seconde' },
  'Go/s': { one: 'gigaoctet par seconde', many: 'gigaoctets par seconde' },
  'Mo/s': { one: 'mégaoctet par seconde', many: 'mégaoctets par seconde' },
  'tokens/s': { one: 'token par seconde', many: 'tokens par seconde' },
  'km²': { one: 'kilomètre carré', many: 'kilomètres carrés' },
  'm²': { one: 'mètre carré', many: 'mètres carrés' },
  m2: { one: 'mètre carré', many: 'mètres carrés' },
  'm³': { one: 'mètre cube', many: 'mètres cubes' },
  km: { one: 'kilomètre', many: 'kilomètres' },
  cm: { one: 'centimètre', many: 'centimètres' },
  mm: { one: 'millimètre', many: 'millimètres' },
  m: { one: 'mètre', many: 'mètres' },
  kg: { one: 'kilogramme', many: 'kilogrammes' },
  mg: { one: 'milligramme', many: 'milligrammes' },
  g: { one: 'gramme', many: 'grammes' },
  ml: { one: 'millilitre', many: 'millilitres' },
  mL: { one: 'millilitre', many: 'millilitres' },
  cl: { one: 'centilitre', many: 'centilitres' },
  l: { one: 'litre', many: 'litres' },
  L: { one: 'litre', many: 'litres' },
  ms: { one: 'milliseconde', many: 'millisecondes', feminine: true },
  min: { one: 'minute', many: 'minutes', feminine: true },
  s: { one: 'seconde', many: 'secondes', feminine: true },
  h: { one: 'heure', many: 'heures', feminine: true },
  To: { one: 'téraoctet', many: 'téraoctets' },
  TB: { one: 'téraoctet', many: 'téraoctets' },
  Go: { one: 'gigaoctet', many: 'gigaoctets' },
  GB: { one: 'gigaoctet', many: 'gigaoctets' },
  Mo: { one: 'mégaoctet', many: 'mégaoctets' },
  MB: { one: 'mégaoctet', many: 'mégaoctets' },
  Ko: { one: 'kilooctet', many: 'kilooctets' },
  ko: { one: 'kilooctet', many: 'kilooctets' },
  KB: { one: 'kilooctet', many: 'kilooctets' },
  kB: { one: 'kilooctet', many: 'kilooctets' },
  Tio: { one: 'tébioctet', many: 'tébioctets' },
  Gio: { one: 'gibioctet', many: 'gibioctets' },
  GiB: { one: 'gibioctet', many: 'gibioctets' },
  Mio: { one: 'mébioctet', many: 'mébioctets' },
  MiB: { one: 'mébioctet', many: 'mébioctets' },
  Kio: { one: 'kibioctet', many: 'kibioctets' },
  GHz: { one: 'gigahertz', many: 'gigahertz' },
  MHz: { one: 'mégahertz', many: 'mégahertz' },
  kHz: { one: 'kilohertz', many: 'kilohertz' },
  Hz: { one: 'hertz', many: 'hertz' },
  kWh: { one: 'kilowattheure', many: 'kilowattheures' },
  kW: { one: 'kilowatt', many: 'kilowatts' },
  W: { one: 'watt', many: 'watts' },
  V: { one: 'volt', many: 'volts' },
  '°C': { one: 'degré Celsius', many: 'degrés Celsius' },
  '°F': { one: 'degré Fahrenheit', many: 'degrés Fahrenheit' },
  '°': { one: 'degré', many: 'degrés' },
  px: { one: 'pixel', many: 'pixels' },
  '%': { one: 'pour cent', many: 'pour cent' },
  '‰': { one: 'pour mille', many: 'pour mille' },
  '×': { one: 'fois', many: 'fois' },
  x: { one: 'fois', many: 'fois' },
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

/** Symboles d'unité, du plus long au plus court (« km/h » avant « km », « min » avant « m »). */
const UNIT_ALTERNATION = Object.keys(UNITS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|');

const UNIT_RE = new RegExp(
  String.raw`${BEFORE}(-?)(${NUM}) ?(${UNIT_ALTERNATION})(?![\p{L}\d²³])`,
  'gu',
);

/** Nombre suivi de son unité : « 3,5 Go » → « trois virgule cinq gigaoctets ». */
function unitToFrench(sign: string, raw: string, symbol: string): string {
  const unit = UNITS[symbol];
  if (unit === undefined) return `${sign}${raw}${symbol}`;
  const value = `${sign === '' ? '' : 'moins '}${numberToFrench(raw, { feminine: unit.feminine === true })}`;
  return `${value} ${isPlural(raw) ? unit.many : unit.one}`;
}

// --- Mots ------------------------------------------------------------------

const MONTH_NAMES =
  'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre';

/**
 * Noms féminins fréquents dans les réponses de l'agent : le nombre qui les
 * précède s'accorde (« 1 erreur » → « une erreur »). Liste courte, pas un dictionnaire.
 */
const FEMININE_NOUNS =
  'heure|minute|seconde|semaine|journée|année|nuit|fois|page|ligne|colonne|cellule|feuille|' +
  'personne|erreur|étape|question|réponse|tâche|version|image|photo|vidéo|facture|commande|' +
  'demande|note|réunion|valeur|entrée|table|liste|lettre|phrase|règle|ville|entreprise|société|' +
  'solution|option|raison|fonction|méthode|classe|catégorie|section|partie|fiche|adresse|pièce';

/** Abréviations lues en entier (avant les nombres : « n° 3 »). */
const ABBREVIATIONS: readonly [RegExp, string][] = [
  [/(?<![\p{L}\d])(?:n°|nº|N°|Nº) ?(?=\d)/gu, 'numéro '],
  [/(?<![\p{L}\d])M\. (?=\p{Lu})/gu, 'monsieur '],
  [/(?<![\p{L}\d])MM\. (?=\p{Lu})/gu, 'messieurs '],
  [/(?<![\p{L}\d])Mmes(?![\p{L}\d])\.?/gu, 'mesdames'],
  [/(?<![\p{L}\d])Mme(?![\p{L}\d])\.?/gu, 'madame'],
  [/(?<![\p{L}\d])Mlle(?![\p{L}\d])\.?/gu, 'mademoiselle'],
  [/(?<![\p{L}\d])Dr\.? (?=\p{Lu})/gu, 'docteur '],
  [/(?<![\p{L}\d])Pr\.? (?=\p{Lu})/gu, 'professeur '],
  [/(?<![\p{L}\d])etc\.(?:\.\.)?(?=\s+\p{Lu})/gu, 'et cetera.'],
  [/(?<![\p{L}\d])etc\.(?:\.\.)?/gu, 'et cetera'],
  [/(?<![\p{L}\d])p\. ?ex\./gu, 'par exemple'],
  [/(?<![\p{L}\d])c\.-à-d\./gu, 'c’est-à-dire'],
  [/(?<![\p{L}\d])cf\./gu, 'voir'],
  [/(?<![\p{L}\d])env\.(?= ?\d)/gu, 'environ'],
  [/(?<![\p{L}\d])vs\.?(?![\p{L}\d])/gu, 'contre'],
  [/(?<![\p{L}\d])TTC(?![\p{L}\d])/gu, 'toutes taxes comprises'],
  [/(?<![\p{L}\d])HT(?![\p{L}\d])/gu, 'hors taxes'],
];

/** Extensions et domaines lus « point … » (« ventes.csv » → « ventes point csv »). */
const SPOKEN_EXTENSIONS =
  'csv|tsv|pdf|txt|md|rtf|docx?|xlsx?|pptx?|odt|ods|odp|json|ya?ml|xml|toml|ini|env|html?|css|' +
  'jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|cpp|sh|zsh|sql|log|png|jpe?g|gif|svg|webp|heic|' +
  'mp3|mp4|mov|wav|m4a|zip|tar|gz|tgz|dmg|pkg|eml|msg|ics|vcf|numbers|pages|key|' +
  'com|org|net|fr|be|eu|io|dev|ai|app|nl|lu|ch|ca|uk|de';
const FILE_NAME_RE = new RegExp(
  String.raw`(?<![\p{L}\d.])([\p{L}\d][\p{L}\d_-]*(?:\.[\p{L}\d_-]+)*)\.(${SPOKEN_EXTENSIONS})(?![\p{L}\d])`,
  'giu',
);

// --- Filtre en ligne -------------------------------------------------------

/** Retire le markdown en ligne, les URL et les emoji ; réduit les chemins au nom du fichier. */
function stripMarkup(input: string): string {
  let s = input;
  // Balises HTML et liens automatiques (`<https://…>`).
  s = s.replace(/<(?:https?|ftp|mailto):[^>\s]*>/giu, '');
  s = s.replace(/<\/?[a-zA-Z][^<>]*>/gu, ' ');
  // Images et liens : on garde le texte (« [le rapport](https://…) » → « le rapport »).
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1');
  // Code en ligne : on garde le contenu, que les règles suivantes nettoient.
  s = s.replace(/`+([^`]+)`+/gu, '$1');
  // URL, sans la ponctuation qui les suit.
  s = s.replace(
    /(?:\b(?:https?|ftp):\/\/|\bwww\.|\bmailto:)[^\s<>"«»]*/giu,
    (url) => /[.,;:!?)\]]+$/u.exec(url)?.[0] ?? '',
  );
  return s;
}

/** Chemins complets → nom du fichier ou du dossier. */
function stripPaths(input: string): string {
  const basename = (path: string, separator: string): string => {
    const trailing = /[.,;:!?)\]»"]+$/u.exec(path)?.[0] ?? '';
    const body = path.slice(0, path.length - trailing.length);
    const parts = body
      .split(separator)
      .filter((p) => p !== '' && p !== '~' && p !== '.' && p !== '..');
    return `${parts.at(-1) ?? ''}${trailing}`;
  };
  let s = input;
  // Windows : « C:\Users\gilles\ventes.csv ».
  s = s.replace(/(?<![\p{L}\d])[A-Za-z]:\\[^\s"'«»]*/gu, (p) => basename(p, '\\'));
  // Absolu ou relatif explicite : « /Users/… », « ~/… », « ./… », « ../… ».
  s = s.replace(/(?<=^|[\s("'«[])(?:~|\.{1,2})?\/[^\s"'«»()[\]]+/gu, (p) => basename(p, '/'));
  // Relatif d'au moins trois segments : « src/main/index.ts ».
  s = s.replace(
    /(?<=^|[\s("'«[])[\p{L}\d_.@-]+(?:\/[\p{L}\d_.@-]+){2,}\/?(?=$|[\s)"'»\],;:!?])/gu,
    (p) => basename(p, '/'),
  );
  return s;
}

/** Emphase markdown (`**gras**`, `*italique*`, `_italique_`, `~~barré~~`). */
function stripEmphasis(input: string): string {
  return input
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/gu, '$2')
    .replace(/~~(?=\S)([^\n]*?\S)~~/gu, '$1')
    .replace(/(?<![\p{L}\d*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\d*])/gu, '$1')
    .replace(/(?<![\p{L}\d_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\d_])/gu, '$1');
}

/** Emoji et pictogrammes, avec leurs sélecteurs de variante. */
function stripEmoji(input: string): string {
  // Alternation plutôt qu'une classe : les séquences jointes (ZWJ, teintes) restent lisibles.
  return input.replace(
    /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]|\u{FE0F}|\u{200D}|\u{20E3}/gu,
    '',
  );
}

/** Nombres, dates, heures, montants, unités : tout en toutes lettres. */
function spellNumbers(input: string): string {
  let s = input;
  // Milliers séparés par des points (« 1.234.567 ») ; un seul groupe reste ambigu (« 3.500 »).
  s = s.replace(/(?<![\d.])\d{1,3}(?:\.\d{3}){2,}(?!\d|\.\d)/gu, (m) => m.replace(/\./gu, ''));
  // Dates jj.mm.aaaa, avant les numéros de version qui les prendraient.
  s = s.replace(
    /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d|\.\d)/gu,
    (m, d: string, mo: string, y: string) => dateToFrench(Number(d), Number(mo), Number(y)) ?? m,
  );
  // Numéros de version (« 2.0.1 ») : « deux point zéro point un ».
  s = s.replace(/(?<![\d.])\d+(?:\.\d+){2,}(?!\d|\.\d)/gu, (m) =>
    m
      .split('.')
      .map((d) => digitStringToFrench(d))
      .join(' point '),
  );
  // Dates ISO (jj/mm/aaaa : voir `spellDatesBeforePaths`).
  s = s.replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu, (m, y: string, mo: string, d: string) => {
    return dateToFrench(Number(d), Number(mo), Number(y)) ?? m;
  });
  // « 1 novembre », « 1er novembre » → « premier novembre ».
  s = s.replace(
    new RegExp(String.raw`${BEFORE}1(?:er|ᵉʳ)? (?=(?:${MONTH_NAMES})${AFTER})`, 'giu'),
    'premier ',
  );
  // Intervalles (« 2020-2026 », « 10–12 ») : « deux mille vingt à deux mille vingt-six ».
  s = s.replace(new RegExp(String.raw`(${NUM}) ?[-–] ?(?=\d)`, 'gu'), '$1 à ');
  // Multiplication écrite avec une étoile (« 2 * 3 »).
  s = s.replace(/(?<=\d) ?\* ?(?=\d)/gu, ' fois ');
  // Heures : « 14h30 », « 14 h 30 », « 9h », « 14:30 ».
  s = s.replace(
    /(?<![\d:,.])([01]?\d|2[0-3]) ?[hH] ?([0-5]\d)?(?![\p{L}\d])/gu,
    (_m, h: string, min: string | undefined) => timeToFrench(Number(h), Number(min ?? 0)),
  );
  s = s.replace(
    /(?<![\d:,.])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?![\d:])/gu,
    (_m, h: string, min: string) => timeToFrench(Number(h), Number(min)),
  );
  // Montants : « 12,50 € », « 1 200 € », « 2,5 M€ », « 15 k€ », « €12 », « $5 ».
  s = s.replace(
    new RegExp(
      String.raw`${BEFORE}(${NUM}) ?(k|K|M|Mds?|Mrd)? ?(€|EUR|USD|GBP|CHF|\$|£)(?![\p{L}\d])`,
      'gu',
    ),
    (_m, raw: string, scale: string | undefined, currency: string) =>
      amountToFrench(raw, currency, scale),
  );
  s = s.replace(
    new RegExp(String.raw`(€|\$|£) ?(${NUM})(?: ?(k|K|M|Mds?|Mrd)${AFTER})?`, 'gu'),
    (_m, currency: string, raw: string, scale: string | undefined) =>
      amountToFrench(raw, currency, scale),
  );
  // Ordinaux : « 1er », « 1re », « 2e », « 3ème », « 2nd », « XXIe » (romains : non traités).
  s = s.replace(
    /(?<![\p{L}\d])(\d+)(er|ᵉʳ|re|ère|ʳᵉ|nde|nd|ème|eme|ième|e|ᵉ|è)(?![\p{L}\d])/gu,
    (_m, n: string, suffix: string) => {
      const value = Number(n);
      if (suffix === 'nd') return value === 2 ? 'second' : ordinalToFrench(value);
      if (suffix === 'nde') return value === 2 ? 'seconde' : ordinalToFrench(value, true);
      const feminine = suffix === 're' || suffix === 'ère' || suffix === 'ʳᵉ';
      return ordinalToFrench(value, feminine);
    },
  );
  // Unités, pourcentages, multiplicateurs : « 3,5 Go », « 15 % », « 3x ».
  s = s.replace(UNIT_RE, (_m, sign: string, raw: string, symbol: string) =>
    unitToFrench(sign, raw, symbol),
  );
  // Signes devant un nombre et opérateurs.
  s = s.replace(/(?<![\p{L}\d])[-−](?=\d)/gu, 'moins ');
  s = s.replace(/(?<![\p{L}\d])\+(?=\d)/gu, 'plus ');
  s = s.replace(/ \+ /gu, ' plus ');
  s = s.replace(/ = /gu, ' égale ');
  s = s.replace(/±/gu, ' plus ou moins ');
  s = s.replace(/(?:~|≈) ?(?=\d)/gu, 'environ ');
  // Fractions restantes : « 3/4 » → « trois sur quatre ».
  s = s.replace(new RegExp(String.raw`(${NUM}) ?/ ?(?=\d)`, 'gu'), '$1 sur ');
  // Chiffres collés à des lettres (« Qwen3 », « M4 », « 4K ») : séparés pour être lus.
  s = s.replace(/(?<=\p{L})(?=\d)/gu, ' ').replace(/(?<=\d)(?=\p{L})/gu, ' ');
  // Devant un nom féminin courant, le « un » final s'accorde (« une erreur », « vingt et une pages »).
  s = s.replace(
    new RegExp(String.raw`(?<!\d)(${NUM})(?= (?:${FEMININE_NOUNS})s?${AFTER})`, 'giu'),
    (raw: string) => numberToFrench(raw, { feminine: true }),
  );
  // Tout nombre restant.
  s = s.replace(new RegExp(String.raw`(?<!\d)(${NUM})(?!\d)`, 'gu'), (raw: string) =>
    numberToFrench(raw),
  );
  return s;
}

/** Ponctuation et symboles résiduels, espaces. */
function tidy(input: string): string {
  return input
    .replace(/&/gu, ' et ')
    .replace(/\s*(?:→|⇒|->|=>|—|–)\s*/gu, ', ')
    .replace(/[*_#|<>{}[\]^~`\\]/gu, ' ')
    .replace(/\//gu, ' ')
    .replace(/[()]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/ ([,.;:!?…])/gu, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/gu, '$1')
    .replace(/[,;:]\s*([.!?…])/gu, '$1')
    .replace(/^[\s,;:.!?…-]+/u, '')
    .trim();
}

/**
 * Filtre une phrase (ou une ligne) de l'agent : rend le texte à prononcer, ou
 * une chaîne vide s'il n'y a rien à dire (ligne de symboles, URL seule).
 */
export function speakableLine(line: string): string {
  let s = line.replace(/[\u00A0\u202F\u2007]/gu, ' ').replace(/[\u200B\u2060\uFEFF]/gu, '');
  s = stripLinePrefix(s);
  const startsWithDigit = /^[\s*_~`([«"]*[-+]?\d/u.test(s);
  s = stripMarkup(s);
  s = spellDatesBeforePaths(s);
  s = stripPaths(s);
  s = stripEmphasis(s);
  s = stripEmoji(s);
  for (const [pattern, replacement] of ABBREVIATIONS) s = s.replace(pattern, replacement);
  s = s.replace(
    FILE_NAME_RE,
    (_m, name: string, ext: string) =>
      `${name.replace(/[_-]+/gu, ' ').replace(/\./gu, ' point ')} point ${ext.toLowerCase()}`,
  );
  s = spellNumbers(s);
  s = tidy(s);
  if (!/[\p{L}\d]/u.test(s)) return '';
  // Ligne qui commençait par un chiffre (« 3 clients ») : majuscule initiale,
  // comme une phrase. La suite d'une phrase coupée à la virgule reste en minuscule.
  return startsWithDigit ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Dates « jj/mm/aaaa » lues avant les chemins, qui les prendraient pour « 10/11/2026 ». */
function spellDatesBeforePaths(input: string): string {
  return input.replace(
    /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/gu,
    (m, d: string, mo: string, y: string) =>
      dateToFrench(Number(d), Number(mo), y.length === 2 ? 2000 + Number(y) : Number(y)) ?? m,
  );
}

/**
 * Texte complet de l'agent → texte à prononcer : blocs de code, tableaux et
 * filets retirés, chaque ligne filtrée par {@link speakableLine}. Une ligne
 * sans ponctuation finale (titre, puce) reçoit un point, pour l'intonation.
 */
export function speakableFrench(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/u)) {
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || isTableLine(line) || isRuleLine(line)) continue;
    const spoken = speakableLine(line);
    if (spoken !== '') out.push(endWithPunctuation(spoken));
  }
  return out.join(' ');
}

/** Ajoute un point final à une phrase qui n'a pas de ponctuation finale. */
export function endWithPunctuation(sentence: string): string {
  return /[.!?…,;:]["»”')\]]*$/u.test(sentence) ? sentence : `${sentence}.`;
}
