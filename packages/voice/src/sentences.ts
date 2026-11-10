/**
 * Découpage du texte de l'agent en morceaux à synthétiser, au fil du flux
 * (ADR-004 D7, L7).
 *
 * - Une phrase par morceau ; une ligne (titre, puce) est aussi un morceau.
 * - **La première phrase d'une réponse est coupée à sa première virgule ou à
 *   son premier deux-points** (premier morceau d'au moins
 *   {@link FIRST_CLAUSE_MIN_CHARS} caractères, reste aussi long) : Supertonic
 *   rend une phrase d'un bloc, le premier son part donc plus tôt (S2 : médiane
 *   0,54 s au lieu de 0,70 s).
 * - Blocs de code, tableaux et filets ne sont jamais prononcés.
 * - Chaque morceau passe par le filtre « prononçable » ({@link speakableLine}).
 *
 * Le découpeur ne garde que le texte pas encore prononcé ; il ne journalise rien.
 */
import {
  endWithPunctuation,
  isFenceLine,
  isPendingLineStart,
  isRuleLine,
  isTableLine,
  speakableLine,
  stripLinePrefix,
} from './speakable.js';

/** Longueur minimale du premier morceau, et du reste de la phrase, pour couper à la virgule (S2). */
export const FIRST_CLAUSE_MIN_CHARS = 12;
/** Au-delà, une phrase sans ponctuation finale est coupée (virgule, sinon espace). */
export const MAX_CHUNK_CHARS = 300;

export interface SpeechChunkerOptions {
  /** Coupe la première phrase à sa première virgule ou à son premier deux-points ; vrai par défaut. */
  splitFirstClause?: boolean;
}

/** Abréviations suivies d'un point qui ne finissent pas une phrase. */
const ABBREVIATIONS = new Set([
  'm',
  'mm',
  'mme',
  'mmes',
  'mlle',
  'dr',
  'pr',
  'me',
  'p',
  'ex',
  'cf',
  'env',
  'vs',
  'art',
  'av',
  'apr',
  'st',
  'ste',
  'n',
  'no',
  'vol',
  'chap',
  'fig',
  'éd',
  'c',
  'd',
  'j',
]);

/** Fin de phrase : ponctuation (et guillemets ou parenthèses fermants) suivie d'une espace. */
const SENTENCE_END = /[.!?…]+["»”')\]]*(?=\s)/gu;

/** Position juste après la première fin de phrase de `segment`, ou -1. */
export function findSentenceEnd(segment: string): number {
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(segment); m !== null; m = SENTENCE_END.exec(segment)) {
    const end = m.index + m[0].length;
    if (m[0].startsWith('.') && m[0].length === 1) {
      const word = /([\p{L}.-]+)$/u.exec(segment.slice(0, m.index))?.[1] ?? '';
      const last = word.split(/[.-]/u).at(-1) ?? '';
      // Initiale (« J. Dupont ») ou abréviation (« M. », « p. ex. ») : pas une fin de phrase.
      if (/^\p{Lu}$/u.test(last) || ABBREVIATIONS.has(last.toLowerCase())) continue;
      // « etc. » ne finit la phrase que devant une majuscule.
      if (last.toLowerCase() === 'etc' && !/^\s+\p{Lu}/u.test(segment.slice(end))) continue;
    }
    return end;
  }
  return -1;
}

/**
 * Coupure de la première phrase : position juste après la première virgule ou
 * le premier deux-points suivis d'une espace, quand le morceau fait au moins
 * {@link FIRST_CLAUSE_MIN_CHARS} caractères. -1 sinon.
 */
export function findFirstClauseEnd(sentence: string): number {
  const re = /[,:](?=\s)/gu;
  for (let m = re.exec(sentence); m !== null; m = re.exec(sentence)) {
    const end = m.index + 1;
    if (end >= FIRST_CLAUSE_MIN_CHARS) return end;
  }
  return -1;
}

/** Coupe une phrase trop longue : dernière virgule (ou point-virgule), sinon dernière espace. */
function findForcedCut(segment: string): number {
  const head = segment.slice(0, MAX_CHUNK_CHARS);
  const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
  if (clause >= FIRST_CLAUSE_MIN_CHARS) return clause + 1;
  const space = head.lastIndexOf(' ');
  return space > 0 ? space : MAX_CHUNK_CHARS;
}

/**
 * Découpeur au fil du flux : `push` reçoit les morceaux de texte du LLM et rend
 * les morceaux prêts à prononcer ; `flush` rend le reste à la fin du tour.
 */
export class SpeechChunker {
  private buffer = '';
  private atLineStart = true;
  private inFence = false;
  private spoken = 0;
  private readonly splitFirstClause: boolean;

  constructor(options: SpeechChunkerOptions = {}) {
    this.splitFirstClause = options.splitFirstClause ?? true;
  }

  /** Nombre de morceaux rendus depuis le début du tour. */
  get count(): number {
    return this.spoken;
  }

  /** Ajoute du texte ; rend les morceaux complets, filtrés. */
  push(delta: string): string[] {
    this.buffer += delta.replace(/\r\n?/gu, '\n');
    return this.extract(false);
  }

  /** Fin du tour : rend tout ce qui reste (sauf un bloc de code non fermé). */
  flush(): string[] {
    const out = this.extract(true);
    this.buffer = '';
    this.atLineStart = true;
    this.inFence = false;
    return out;
  }

  private extract(final: boolean): string[] {
    const out: string[] = [];
    const emit = (raw: string): void => {
      const spoken = speakableLine(raw);
      if (spoken === '') return;
      out.push(endWithPunctuation(spoken));
      this.spoken += 1;
    };

    while (this.buffer !== '') {
      const nl = this.buffer.indexOf('\n');
      const line = nl >= 0 ? this.buffer.slice(0, nl) : this.buffer;
      const complete = nl >= 0 || final;

      if (this.atLineStart) {
        if (nl === 0) {
          this.buffer = this.buffer.slice(1);
          continue;
        }
        if (this.inFence || isFenceLine(line) || /^\s*\|/u.test(line)) {
          // Code et tableaux : on attend la ligne entière, puis on la jette.
          if (!complete) break;
          if (isFenceLine(line)) this.inFence = !this.inFence;
          this.dropLine(nl);
          continue;
        }
        if (!complete && isPendingLineStart(line)) break;
        if (complete && (isTableLine(line) || isRuleLine(line) || line.trim() === '')) {
          this.dropLine(nl);
          continue;
        }
        this.buffer = stripLinePrefix(this.buffer);
        this.atLineStart = false;
        continue;
      }

      // Milieu de ligne : chercher la fin de la phrase (ou de la première proposition).
      const segment = nl >= 0 ? this.buffer.slice(0, nl) : this.buffer;
      const end = findSentenceEnd(segment);
      const sentence = end >= 0 ? segment.slice(0, end) : segment;

      if (this.splitFirstClause && this.spoken === 0) {
        const clause = findFirstClauseEnd(sentence);
        if (clause >= 0) {
          const rest = sentence.slice(clause).trim().length;
          const sentenceDone = end >= 0 || complete;
          if (rest >= FIRST_CLAUSE_MIN_CHARS) {
            emit(sentence.slice(0, clause));
            this.consume(clause);
            continue;
          }
          // Reste encore court : attendre la suite, sauf si la phrase est finie.
          if (!sentenceDone) break;
        }
      }

      if (end >= 0) {
        emit(sentence);
        this.consume(end);
        continue;
      }
      if (complete) {
        emit(segment);
        this.dropLine(nl);
        continue;
      }
      if (segment.length > MAX_CHUNK_CHARS) {
        const cut = findForcedCut(segment);
        emit(segment.slice(0, cut));
        this.consume(cut);
        continue;
      }
      break;
    }
    return out;
  }

  /** Retire la ligne en cours, saut de ligne compris. */
  private dropLine(nl: number): void {
    this.buffer = nl >= 0 ? this.buffer.slice(nl + 1) : '';
    this.atLineStart = true;
  }

  /** Retire `n` caractères prononcés et les espaces qui suivent (pas le saut de ligne). */
  private consume(n: number): void {
    this.buffer = this.buffer.slice(n).replace(/^[ \t]+/u, '');
  }
}

/** Découpe un texte complet en morceaux prononçables (sans flux). */
export function splitSpeech(text: string, options: SpeechChunkerOptions = {}): string[] {
  const chunker = new SpeechChunker(options);
  return [...chunker.push(text), ...chunker.flush()];
}
