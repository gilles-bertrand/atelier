/**
 * Texte de la dictée (ADR-004 D6) : langue, typographie française, assemblage.
 *
 * Parakeet fournit ponctuation et majuscules, mais pas la typographie
 * française. Quand un segment est en français, l'app ajoute les espaces
 * insécables avant « : ; ! ? » et à l'intérieur des guillemets « ». Les autres
 * langues (néerlandais, anglais…) gardent leur texte tel quel.
 *
 * Fonctions pures, sans dépendance.
 */

/** Espace insécable, avant le deux-points et à l'intérieur des guillemets. */
export const NBSP = ' ';
/** Espace fine insécable, avant le point-virgule, le point d'exclamation et le point d'interrogation. */
export const NNBSP = ' ';

/** Langue d'un texte, pour la typographie seulement. */
export type TextLanguage = 'fr' | 'other' | 'unknown';

/** Mots outils propres au français (formes élidées comprises : `c'`, `l'`…). */
const FRENCH_WORDS = new Set([
  'le',
  'la',
  'les',
  'une',
  'des',
  'du',
  'et',
  'est',
  'sont',
  'pas',
  'qui',
  'pour',
  'dans',
  'sur',
  'avec',
  'ce',
  'cette',
  'ces',
  'je',
  'tu',
  'il',
  'elle',
  'nous',
  'vous',
  'ils',
  'elles',
  'on',
  'ne',
  'au',
  'aux',
  'mais',
  'ou',
  'donc',
  'car',
  'mon',
  'ma',
  'mes',
  'ton',
  'ta',
  'ses',
  'sa',
  'leur',
  'leurs',
  'très',
  'aussi',
  'être',
  'avoir',
  'fait',
  'comme',
  'plus',
  'tout',
  'tous',
  'bien',
  'oui',
  'non',
  'merci',
  'bonjour',
  'peux',
  'peut',
  'fichier',
  'fichiers',
  'dossier',
  'c',
  'l',
  'd',
  'j',
  'qu',
  'n',
  's',
  'm',
  't',
  'à',
  'où',
  'ça',
  'été',
  'déjà',
  'après',
]);

/** Mots outils d'autres langues probables (anglais, néerlandais, allemand, espagnol, italien). */
const OTHER_WORDS = new Set([
  // anglais
  'the',
  'and',
  'is',
  'are',
  'to',
  'of',
  'that',
  'it',
  'for',
  'with',
  'you',
  'this',
  'not',
  'be',
  'have',
  'was',
  'what',
  'can',
  'please',
  'my',
  'your',
  'from',
  'will',
  'would',
  'there',
  // néerlandais
  'het',
  'een',
  'van',
  'dat',
  'niet',
  'ik',
  'jij',
  'wij',
  'zijn',
  'op',
  'met',
  'voor',
  'maar',
  'ook',
  'kan',
  'wat',
  'dit',
  'deze',
  'bestand',
  'graag',
  'alsjeblieft',
  // allemand
  'der',
  'die',
  'das',
  'und',
  'ist',
  'nicht',
  'ich',
  'sie',
  'es',
  'ein',
  'eine',
  'zu',
  'mit',
  'auf',
  'auch',
  'bitte',
  'wir',
  // espagnol, italien
  'el',
  'los',
  'las',
  'y',
  'por',
  'para',
  'con',
  'lo',
  'gli',
  'il',
  'che',
  'della',
  'sono',
]);

/** Lettres accentuées surtout françaises (é et à existent ailleurs, mais rarement ensemble). */
const FRENCH_LETTERS = /[éèêëàâçùûüôîïœ]/g;

/**
 * Devine si un texte est en français, d'après ses mots outils et ses accents.
 * Rend `unknown` pour un texte trop court pour trancher (« OK ? »).
 */
export function detectTextLanguage(text: string, engineLang?: string): TextLanguage {
  const fromEngine = normalizeEngineLang(engineLang);
  if (fromEngine !== 'unknown') return fromEngine;

  const words = text
    .toLowerCase()
    .split(/[^a-zà-ÿœæ]+/u)
    .filter((w) => w !== '');
  let fr = 0;
  let other = 0;
  for (const word of words) {
    // « il » est commun au français et à l'italien : il compte pour le français.
    if (FRENCH_WORDS.has(word)) fr += 1;
    else if (OTHER_WORDS.has(word)) other += 1;
  }
  const accents = text.toLowerCase().match(FRENCH_LETTERS)?.length ?? 0;
  fr += Math.min(accents, 2) * 0.5;
  if (fr === 0 && other === 0) return 'unknown';
  if (fr > other) return 'fr';
  if (other > fr) return 'other';
  return 'unknown';
}

/** `fr`, `fr-BE`, `<|fr|>` → `fr` ; une autre langue → `other` ; vide → `unknown`. */
function normalizeEngineLang(lang: string | undefined): TextLanguage {
  if (lang === undefined) return 'unknown';
  const code = lang.replace(/[<|>]/g, '').trim().toLowerCase();
  if (code === '') return 'unknown';
  return code === 'fr' || code.startsWith('fr-') || code.startsWith('fr_') ? 'fr' : 'other';
}

const SPACES = new Set([' ', '\t', NBSP, NNBSP]);
const HIGH_PUNCTUATION = new Set([':', ';', '!', '?']);
/** Caractères après lesquels on n'insère pas d'espace (début de groupe ou ponctuation). */
const NO_SPACE_AFTER = new Set([':', ';', '!', '?', '«', '(', '[', '{', '\n']);

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

/** Retire les espaces de fin de `out` ; rend leur nombre. */
function trimTrailingSpaces(out: string[]): number {
  let n = 0;
  while (out.length > 0 && SPACES.has(out[out.length - 1] ?? '')) {
    out.pop();
    n += 1;
  }
  return n;
}

/**
 * Typographie française : espace insécable avant « : » et à l'intérieur des
 * guillemets « », espace fine insécable avant « ; ! ? ». Idempotente.
 *
 * Laisse intactes les heures et les adresses (`10:30`, `https://`), et les
 * ponctuations doubles (`?!`).
 */
export function applyFrenchTypography(text: string): string {
  const out: string[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] ?? '';
    if (HIGH_PUNCTUATION.has(c)) {
      const removed = trimTrailingSpaces(out);
      const prev = out[out.length - 1];
      const next = chars[i + 1];
      const isTime = c === ':' && removed === 0 && isDigit(prev) && isDigit(next);
      const isUrl = c === ':' && removed === 0 && next === '/' && chars[i + 2] === '/';
      if (prev === undefined || NO_SPACE_AFTER.has(prev) || isTime || isUrl) {
        // Rien à ajouter : on remet les espaces d'origine.
        for (let k = 0; k < removed; k += 1) out.push(' ');
      } else {
        out.push(c === ':' ? NBSP : NNBSP);
      }
      out.push(c);
    } else if (c === '«') {
      out.push('«');
      let j = i + 1;
      while (j < chars.length && SPACES.has(chars[j] ?? '')) j += 1;
      if (j < chars.length && chars[j] !== '»') out.push(NBSP);
      i = j - 1;
    } else if (c === '»') {
      trimTrailingSpaces(out);
      if (out.length > 0 && out[out.length - 1] !== '«') out.push(NBSP);
      out.push('»');
    } else {
      out.push(c);
    }
  }
  return out.join('');
}

/**
 * Abréviations courantes (fr, en, nl) dont le point n'est pas une fin de
 * phrase : il reste en place même si le segment suivant commence par une
 * minuscule.
 */
const ABBREVIATIONS = new Set([
  'etc',
  'cf',
  'ex',
  'env',
  'vs',
  'approx',
  'resp',
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'no',
  'nr',
  'bijv',
  'enz',
  'dhr',
  'mevr',
  'ca',
]);

/**
 * Point final d'un segment qui n'est pas une vraie fin de phrase : Parakeet
 * ponctue chaque segment comme une phrase complète, même quand la pause tombe
 * au milieu d'une phrase. Rend vrai si `text` se termine par un point simple
 * (ni « ... », ni « … », ni une abréviation comme « etc. » ou « e.g. »).
 */
function endsWithPauseFullStop(text: string): boolean {
  if (!text.endsWith('.') || text.endsWith('..')) return false;
  const lastWord = text.slice(0, -1).split(/\s+/).pop() ?? '';
  // « e.g. », « U.S. », « o.a. » : point interne, abréviation.
  if (lastWord.includes('.')) return false;
  return !ABBREVIATIONS.has(lastWord.toLowerCase());
}

/** Vrai si `text` commence par une minuscule (après d'éventuels guillemets ou parenthèses). */
function startsLowercase(text: string): boolean {
  const first = /\p{L}/u.exec(text.replace(/^[«"“'‘(\s]+/u, ''));
  return first?.index === 0 && /\p{Ll}/u.test(first[0]);
}

/**
 * Assemble les textes des segments d'une dictée : espaces superflus retirés,
 * segments vides ignorés, une espace entre deux segments.
 *
 * Le point qui ferme un segment est retiré quand le segment suivant commence
 * par une minuscule : la pause tombait au milieu d'une phrase (« liste les
 * actions. les responsables » → « liste les actions les responsables »). Les
 * « ? », « ! » et « … » restent, comme un point suivi d'une majuscule.
 */
export function assembleSegments(texts: readonly string[]): string {
  const parts = texts.map((t) => t.replace(/[ \t]+/g, ' ').trim()).filter((t) => t !== '');
  let out = '';
  for (const part of parts) {
    if (out === '') {
      out = part;
      continue;
    }
    if (startsLowercase(part) && endsWithPauseFullStop(out)) out = out.slice(0, -1);
    out += ` ${part}`;
  }
  return out;
}
