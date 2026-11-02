/**
 * Catalogue des modèles de voix (ADR-004 D4, D5).
 *
 * Épinglé dans le code de l'app : chaque modèle a une version, une URL
 * officielle, un SHA-256, une taille et la liste exacte de ses fichiers. Comme
 * dans `scripts/fetch-lima.ts`, l'empreinte n'est **jamais** lue sur le serveur
 * de téléchargement : un miroir ou une archive importée sont contrôlés par la
 * même empreinte. Les modèles changent avec les versions de l'app, jamais en
 * silence (voir `VoiceModelManager.pendingUpdates`).
 *
 * Pour monter de version : télécharger l'archive depuis la release officielle,
 * calculer son SHA-256 (`shasum -a 256`), relever sa taille et la liste de ses
 * fichiers (`tar -tvf`), puis changer `version`, `sha256`, `bytes` et `files`.
 */
import type { VoiceModelInfo, VoiceModelRole } from '@atelier/shared';

/** Fichier attendu dans un modèle installé (chemin relatif, taille exacte). */
export interface VoiceModelFile {
  path: string;
  bytes: number;
}

/** Modèle embarqué dans l'app (`Contents/Resources`), jamais téléchargé. */
export interface BundledVoiceModelSource {
  kind: 'bundled';
  /** Nom du fichier dans le dossier des modèles embarqués. */
  file: string;
  sha256: string;
  bytes: number;
  /** URL d'origine du fichier, pour le packaging (L3). */
  url: string;
}

/** Modèle téléchargé au premier usage, sous forme d'archive tar. */
export interface DownloadedVoiceModelSource {
  kind: 'download';
  /** Nom de l'archive : dernier segment de l'URL, et nom attendu sur un miroir. */
  archiveName: string;
  /** URL officielle (releases GitHub de sherpa-onnx). */
  url: string;
  /** SHA-256 de l'archive, en hexadécimal minuscule. */
  sha256: string;
  /** Taille exacte de l'archive, en octets. */
  bytes: number;
  /** Dossier racine de l'archive ; il devient `<id>@<version>/`. */
  rootDir: string;
  /** Liste exacte des fichiers de l'archive, relatifs à `rootDir`. */
  files: readonly VoiceModelFile[];
}

/** Entrée du catalogue. */
export interface VoiceCatalogEntry {
  id: string;
  role: VoiceModelRole;
  label: string;
  version: string;
  languages: readonly string[];
  memoryEstimateBytes: number;
  /** Identifiant SPDX. Le catalogue ne contient aucune licence non commerciale. */
  license: string;
  /** Texte d'attribution (« À propos › Licences »), exigé par CC-BY. */
  attribution?: string;
  /** Page du modèle (licence, auteurs). */
  homepage: string;
  source: BundledVoiceModelSource | DownloadedVoiceModelSource;
}

/** Langues de Parakeet TDT 0.6B v3 (25 langues européennes, BCP 47). */
const PARAKEET_V3_LANGUAGES = [
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'fi',
  'fr',
  'hr',
  'hu',
  'it',
  'lt',
  'lv',
  'mt',
  'nl',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'uk',
] as const;

const SHERPA_ASR_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

/** Détection de parole, embarquée (ADR-004 §3.6, exception à M1). */
export const SILERO_VAD: VoiceCatalogEntry = {
  id: 'silero-vad',
  role: 'vad',
  label: 'Silero VAD (détection de parole)',
  version: '2025-07-11',
  languages: [],
  memoryEstimateBytes: 20 * 1024 * 1024,
  license: 'MIT',
  attribution:
    'Silero VAD, © Silero Team, sous licence MIT (https://github.com/snakers4/silero-vad).',
  homepage: 'https://github.com/snakers4/silero-vad',
  source: {
    kind: 'bundled',
    file: 'silero_vad.onnx',
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    bytes: 643_854,
    url: `${SHERPA_ASR_RELEASE}/silero_vad.onnx`,
  },
};

/** Reconnaissance par défaut (ADR-004 V3, confirmée par S1). */
export const PARAKEET_TDT_V3_INT8: VoiceCatalogEntry = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  role: 'stt',
  label: 'Parakeet v3 (25 langues européennes)',
  version: '2025-08-16',
  languages: PARAKEET_V3_LANGUAGES,
  // S1 : RSS du worker de 1,30 Go une fois chargé, jusqu'à 1,50 Go après 10 prises.
  memoryEstimateBytes: 1_500_000_000,
  license: 'CC-BY-4.0',
  attribution:
    'Parakeet TDT 0.6B v3, © NVIDIA Corporation, sous licence CC-BY-4.0 ' +
    '(https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). ' +
    'Converti au format ONNX et quantifié en int8 par le projet sherpa-onnx (k2-fsa), sous licence Apache 2.0.',
  homepage: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
  source: {
    kind: 'download',
    archiveName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    url: `${SHERPA_ASR_RELEASE}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
    bytes: 487_170_055,
    rootDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    files: [
      { path: 'encoder.int8.onnx', bytes: 652_184_281 },
      { path: 'decoder.int8.onnx', bytes: 11_845_275 },
      { path: 'joiner.int8.onnx', bytes: 6_355_277 },
      { path: 'tokens.txt', bytes: 93_939 },
      { path: 'test_wavs/de.wav', bytes: 121_388 },
      { path: 'test_wavs/en.wav', bytes: 184_608 },
      { path: 'test_wavs/es.wav', bytes: 235_052 },
      { path: 'test_wavs/fr.wav', bytes: 219_180 },
    ],
  },
};

/** Catalogue de l'app, phase 1. */
export const VOICE_MODEL_CATALOG: readonly VoiceCatalogEntry[] = [SILERO_VAD, PARAKEET_TDT_V3_INT8];

/** Entrée du catalogue, ou `undefined` si l'identifiant est inconnu. */
export function findCatalogEntry(
  id: string,
  catalog: readonly VoiceCatalogEntry[] = VOICE_MODEL_CATALOG,
): VoiceCatalogEntry | undefined {
  return catalog.find((entry) => entry.id === id);
}

/** Taille d'un modèle installé : somme de ses fichiers. */
export function entryDiskBytes(entry: VoiceCatalogEntry): number {
  if (entry.source.kind === 'bundled') return entry.source.bytes;
  return entry.source.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** Taille du téléchargement (0 pour un modèle embarqué). */
export function entryDownloadBytes(entry: VoiceCatalogEntry): number {
  return entry.source.kind === 'download' ? entry.source.bytes : 0;
}

/** Nom du dossier d'installation : `<id>@<version>`. */
export function modelDirName(entry: Pick<VoiceCatalogEntry, 'id' | 'version'>): string {
  return `${entry.id}@${entry.version}`;
}

/** Description publique d'une entrée (`VoiceModelInfo`), pour un état donné. */
export function toModelInfo(
  entry: VoiceCatalogEntry,
  state: VoiceModelInfo['state'],
  extra: Pick<VoiceModelInfo, 'progress' | 'error'> = {},
): VoiceModelInfo {
  return {
    id: entry.id,
    role: entry.role,
    label: entry.label,
    version: entry.version,
    languages: entry.languages,
    downloadBytes: entryDownloadBytes(entry),
    diskBytes: entryDiskBytes(entry),
    memoryEstimateBytes: entry.memoryEstimateBytes,
    license: entry.license,
    ...(entry.attribution !== undefined ? { attribution: entry.attribution } : {}),
    bundled: entry.source.kind === 'bundled',
    state,
    ...extra,
  };
}

/** Ligne de « À propos › Licences ». */
export interface VoiceModelLicense {
  id: string;
  label: string;
  license: string;
  attribution: string;
  homepage: string;
}

/** Attributions des modèles du catalogue, pour « À propos › Licences ». */
export function voiceModelLicenses(
  catalog: readonly VoiceCatalogEntry[] = VOICE_MODEL_CATALOG,
): VoiceModelLicense[] {
  return catalog.map((entry) => ({
    id: entry.id,
    label: entry.label,
    license: entry.license,
    attribution: entry.attribution ?? `${entry.label}, sous licence ${entry.license}.`,
    homepage: entry.homepage,
  }));
}
