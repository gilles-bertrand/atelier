/**
 * Noms de modèle : « atelier » et « atelier:latest » désignent le même modèle
 * Ollama, qui ajoute `:latest` à un nom sans étiquette (`ollama create atelier`
 * est listé `atelier:latest` par `/api/tags`). Toutes les comparaisons de noms
 * du main et du renderer passent par ici.
 *
 * Le nom envoyé au serveur ne change jamais : vLLM sert le nom exact, sans
 * étiquette (`--served-model-name atelier`).
 */

const LATEST_TAG = ':latest';

/** Forme de comparaison d'un nom de modèle : sans le suffixe `:latest`. */
export function modelKey(name: string): string {
  return name.endsWith(LATEST_TAG) ? name.slice(0, -LATEST_TAG.length) : name;
}

/** Vrai si les deux noms désignent le même modèle (`x` et `x:latest`). */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return modelKey(a) === modelKey(b);
}
