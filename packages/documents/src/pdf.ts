/** Extraction du texte des PDF, page par page (unpdf / PDF.js, côté hôte). */
import { getDocumentProxy } from 'unpdf';
import { AtelierError } from '@atelier/shared';

/** Nombre maximal de pages par appel de `read_file`. */
export const MAX_PDF_PAGES_PER_CALL = 20;
/**
 * En deçà de ce nombre de caractères (blancs exclus), une page est considérée
 * comme scannée : elle est rendue en image puis transcrite par le modèle vision.
 */
export const SCANNED_PAGE_MIN_CHARS = 30;

/** Texte d'une page. */
export interface PdfPageText {
  /** Numéro de page (1-based). */
  page: number;
  text: string;
}

/** Résultat d'extraction. */
export interface PdfExtraction {
  totalPages: number;
  pages: PdfPageText[];
}

/**
 * Analyse un intervalle de pages : `"3"`, `"1-10"`, `"1-3,7,9-10"`.
 * Les bornes sont ramenées au nombre total de pages.
 *
 * @throws AtelierError `tool/invalid_input` si la syntaxe est invalide, si aucune
 *   page n'est dans le document ou si plus de {@link MAX_PDF_PAGES_PER_CALL} pages
 *   sont demandées.
 */
export function parsePageRange(spec: string, totalPages: number): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const match = /^(\d+)\s*(?:-\s*(\d+)?)?$/.exec(token);
    if (!match) {
      throw new AtelierError(
        'tool/invalid_input',
        `Intervalle de pages invalide : « ${spec} ». Exemples : "3", "1-10", "1-3,7".`,
      );
    }
    const from = Number(match[1]);
    const to = match[2] !== undefined ? Number(match[2]) : token.includes('-') ? totalPages : from;
    if (from < 1 || to < from) {
      throw new AtelierError('tool/invalid_input', `Intervalle de pages invalide : « ${token} ».`);
    }
    for (let p = from; p <= Math.min(to, totalPages); p++) {
      pages.add(p);
      if (pages.size > MAX_PDF_PAGES_PER_CALL) {
        throw new AtelierError(
          'tool/invalid_input',
          `Trop de pages demandées : ${MAX_PDF_PAGES_PER_CALL} au plus par appel (le PDF en compte ${totalPages}). Lis-le par tranches, ex. pages: "1-20" puis "21-40".`,
        );
      }
    }
  }
  if (pages.size === 0) {
    throw new AtelierError(
      'tool/invalid_input',
      `Aucune page demandée n'existe : le PDF compte ${totalPages} page${totalPages > 1 ? 's' : ''}.`,
    );
  }
  return [...pages].sort((a, b) => a - b);
}

/** Pages lues par défaut (les premières). */
export function defaultPages(totalPages: number): number[] {
  return Array.from({ length: Math.min(totalPages, MAX_PDF_PAGES_PER_CALL) }, (_, i) => i + 1);
}

/** Vrai si le texte d'une page est trop pauvre : page scannée probable. */
export function isScannedPage(text: string): boolean {
  return text.replace(/\s+/g, '').length < SCANNED_PAGE_MIN_CHARS;
}

function isPasswordError(error: unknown): boolean {
  return error instanceof Error && /password/i.test(`${error.name} ${error.message}`);
}

/**
 * Ouvre un PDF et extrait le texte des pages demandées (toutes si `pages` est
 * une fonction de sélection renvoyant toutes les pages).
 *
 * @param data - Contenu du fichier.
 * @param selectPages - Choisit les pages à extraire selon le nombre total.
 */
export async function extractPdfText(
  data: Uint8Array,
  selectPages: (totalPages: number) => number[],
): Promise<PdfExtraction> {
  let pdf;
  try {
    // Copie : PDF.js transfère (et vide) le tampon qu'on lui passe.
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (error) {
    if (isPasswordError(error)) {
      throw new AtelierError(
        'tool/failed',
        'Ce PDF est protégé par un mot de passe : impossible de le lire.',
        {
          cause: error,
        },
      );
    }
    throw new AtelierError('tool/failed', 'PDF illisible ou endommagé.', { cause: error });
  }
  try {
    const totalPages = pdf.numPages;
    const wanted = selectPages(totalPages);
    const pages: PdfPageText[] = [];
    for (const n of wanted) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push({ page: n, text: text.replace(/[ \t]+\n/g, '\n').trim() });
      page.cleanup();
    }
    return { totalPages, pages };
  } finally {
    // `destroy` existe à l'exécution (PDF.js) mais manque aux types d'unpdf.
    const disposable = pdf as unknown as { destroy?: () => Promise<void> };
    await (disposable.destroy ? disposable.destroy() : pdf.cleanup());
  }
}
