/**
 * Extraction du contenu principal d'une page HTML (Readability + jsdom) et
 * conversion en markdown (turndown). Aucun script de la page n'est exécuté et
 * aucune ressource externe n'est chargée.
 */
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';

/** Contenu extrait d'une page. */
export interface ExtractedPage {
  /** Titre de la page, s'il existe. */
  title?: string;
  /** Contenu principal en markdown. */
  markdown: string;
}

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  // Rien d'utile pour le modèle (et parfois volumineux).
  const removed = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'IFRAME',
    'SVG',
    'CANVAS',
    'FORM',
    'BUTTON',
  ]);
  service.remove((node: { nodeName: string }) => removed.has(node.nodeName.toUpperCase()));
  // Images : on garde le texte alternatif seulement (les data: URL peuvent peser des Mo).
  service.addRule('image', {
    filter: 'img',
    replacement: (_content: string, node: { getAttribute?: (n: string) => string | null }) => {
      const alt = node.getAttribute?.('alt');
      return alt ? `[image : ${alt.trim()}]` : '';
    },
  });
  return service;
}

/** Normalise les blancs du markdown (lignes vides multiples, espaces de fin). */
function tidy(markdown: string): string {
  return (
    markdown
      .replace(/[ \t]+\n/g, '\n')
      // turndown aligne les puces sur 4 colonnes (« -   item ») : une espace suffit.
      .replace(/^(\s*)(-|\d+\.) {2,}/gm, '$1$2 ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Extrait le contenu principal d'un document HTML.
 * Repli sur le `<body>` complet si Readability ne trouve pas d'article.
 */
export function extractHtml(html: string, url: string): ExtractedPage {
  // Console virtuelle muette : les erreurs CSS/HTML de la page ne polluent pas les logs.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    const pageTitle = document.title.trim();
    // Readability modifie le document : on lui passe une copie.
    // `never` : sous `lib.dom` (process main d'Electron), Readability attend un vrai `Document`.
    const copy = document.cloneNode(true) as never;
    const article = new Readability(copy, {
      charThreshold: 200,
    }).parse();
    const turndown = createTurndown();
    const source = article?.content ?? document.body.innerHTML;
    const markdown = tidy(turndown.turndown(source));
    const title = article?.title?.trim() || pageTitle;
    return { ...(title ? { title } : {}), markdown };
  } finally {
    dom.window.close();
  }
}
