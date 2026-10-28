/** Formats d'affichage en français. */

const integer = new Intl.NumberFormat('fr-FR');

/** « 32 768 tokens ». */
export function formatContext(tokens: number): string {
  return `${integer.format(tokens)} tokens`;
}

/** Taille lisible : « 23,4 Go », « 812 Ko ». */
export function formatBytes(bytes: number): string {
  const units = ['octets', 'Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(value)} ${units[unit] ?? ''}`;
}

/** Hôte d'une URL, pour les messages (« llm.exemple.fr »). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
