/** Utilitaires texte partagés par les outils web. */

const encoder = new TextEncoder();

/**
 * Tronque un texte à `maxBytes` octets UTF-8 (sans couper un caractère) et
 * ajoute un marqueur explicite pour le modèle.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // `fatal: false` remplace un éventuel caractère coupé en fin de tranche : on le retire.
  const cut = new TextDecoder('utf-8').decode(bytes.subarray(0, maxBytes)).replace(/�$/, '');
  return {
    text: `${cut}\n\n[… contenu tronqué à ${Math.round(maxBytes / 1024)} ko]`,
    truncated: true,
  };
}

/** Message d'erreur lisible depuis n'importe quelle valeur levée. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Retire les balises HTML et décode les entités courantes (extraits Brave, SearXNG). */
export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
