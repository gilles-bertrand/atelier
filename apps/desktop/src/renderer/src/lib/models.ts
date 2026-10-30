/**
 * Règles d'affichage des modèles du serveur (pures, testables) : modèles
 * proposés, compatibilité avec Atelier (D2), famille testée, vision (D4).
 */
import { DEFAULT_MODEL, MODEL_PROFILES, type LlmModelInfo } from '@atelier/shared';

/** Libellé de profil connu (« Recommandé (32 Go et plus) »), s'il existe. */
export function profileLabel(model: string): string | undefined {
  return MODEL_PROFILES.find((p) => p.model === model)?.label;
}

/** Vrai pour un modèle d'embedding (inutilisable pour discuter). */
export function isEmbeddingModel(model: LlmModelInfo): boolean {
  if (model.capabilities?.length === 1 && model.capabilities[0] === 'embedding') return true;
  return /embed/i.test(model.name) || /bert/i.test(model.family ?? '');
}

/**
 * Modèles proposés : sans les modèles d'embedding, profils connus d'abord
 * (dans l'ordre des profils, le recommandé en tête), puis les autres par nom.
 */
export function chatModels(models: readonly LlmModelInfo[]): LlmModelInfo[] {
  const rank = (name: string): number => {
    if (name === DEFAULT_MODEL) return -1;
    const index = MODEL_PROFILES.findIndex((p) => p.model === name);
    return index < 0 ? MODEL_PROFILES.length : index;
  };
  return models
    .filter((m) => !isEmbeddingModel(m))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** Le modèle sait appeler des outils. Capacités inconnues (vLLM) : autorisé (D2). */
export function supportsTools(model: LlmModelInfo): boolean {
  return model.capabilities?.includes('tools') ?? true;
}

/** Raison affichée sous un modèle sans outils (entrée grisée). */
export const NO_TOOLS_REASON = 'ne sait pas utiliser les outils : lecture de fichiers, commandes';

/**
 * Familles testées : celles des profils connus présents sur le serveur.
 * Une famille vide est ignorée : Ollama la laisse vide pour les modèles MLX
 * dans `/api/tags` (0.40), elle ne distingue alors rien.
 */
function testedFamilies(models: readonly LlmModelInfo[]): Set<string> {
  const families = new Set<string>();
  for (const m of models) {
    if (profileLabel(m.name) !== undefined && m.family) families.add(m.family);
  }
  return families;
}

/**
 * Modèle de la famille Qwen 3.5 testée avec Atelier : un profil connu, ou un
 * modèle de même famille qu'un profil présent (ex. `atelier`, dérivé de qwen3.5).
 */
export function isTestedModel(model: LlmModelInfo, all: readonly LlmModelInfo[]): boolean {
  if (profileLabel(model.name) !== undefined) return true;
  return model.family !== undefined && model.family !== '' && testedFamilies(all).has(model.family);
}

/** Modèle à présélectionner : celui demandé s'il est utilisable, sinon le défaut, sinon le premier utilisable. */
export function initialModel(models: readonly LlmModelInfo[], current: string): string | undefined {
  const usable = models.filter(supportsTools).map((m) => m.name);
  if (usable.includes(current)) return current;
  if (usable.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  return usable[0];
}

/**
 * Une image jointe pourra-t-elle être lue (D4) ? Oui si un modèle vision est
 * réglé, ou si le modèle de la conversation a `vision` ou des capacités
 * inconnues. `undefined` : on ne sait pas encore (modèle non décrit).
 */
export function canReadImages(
  model: LlmModelInfo | undefined,
  visionModel: string | undefined,
): boolean | undefined {
  if (visionModel !== undefined && visionModel !== '') return true;
  if (!model) return undefined;
  return model.capabilities?.includes('vision') ?? true;
}

/** Vrai pour une pièce jointe image. */
export function isImage(mimeType: string | undefined): boolean {
  return mimeType?.startsWith('image/') === true;
}
