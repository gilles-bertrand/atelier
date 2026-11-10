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
  /**
   * Modèle d'origine dont l'archive est dérivée (dépôt et révision exacte),
   * épinglé comme l'empreinte : la licence s'applique à cette révision.
   */
  upstream?: { repo: string; revision: string };
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
const SHERPA_TTS_RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';

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

/**
 * Synthèse vocale (phase 2, S2) : Supertonic 3 en int8. Le modèle est sous
 * BigScience OpenRAIL-M (usages restreints, annexe A transmise aux
 * utilisateurs : ADR-004 D5, charte #43) ; le code de Supertone est sous MIT.
 * Aucun phonémiseur : le modèle lit le texte brut (pas de module GPL).
 */
export const SUPERTONIC_3_INT8: VoiceCatalogEntry = {
  id: 'supertonic-3-tts-int8',
  role: 'tts',
  label: 'Supertonic 3 (voix de synthèse française)',
  version: '2026-05-11',
  languages: ['fr'],
  // S2 : 0,52 Gio de RSS pour le process Node complet, modèle chargé.
  memoryEstimateBytes: 560_000_000,
  license: 'OpenRAIL-M',
  attribution:
    'Supertonic 3, © Supertone Inc., modèle sous licence BigScience OpenRAIL-M ' +
    '(https://huggingface.co/Supertone/supertonic-3, révision 3cadd1ee6394adea1bd021217a0e650ede09a323), ' +
    'code sous licence MIT. Converti au format ONNX et quantifié en int8 par le projet sherpa-onnx ' +
    '(k2-fsa) : fichiers modifiés. Voix synthétique ; restrictions d’usage de l’annexe A de la licence, ' +
    'reprises dans la charte d’utilisation.',
  homepage: 'https://huggingface.co/Supertone/supertonic-3',
  upstream: {
    repo: 'Supertone/supertonic-3',
    revision: '3cadd1ee6394adea1bd021217a0e650ede09a323',
  },
  source: {
    kind: 'download',
    archiveName: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2',
    url: `${SHERPA_TTS_RELEASE}/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`,
    sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427',
    bytes: 128_774_318,
    rootDir: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
    files: [
      { path: 'duration_predictor.int8.onnx', bytes: 3_700_147 },
      { path: 'text_encoder.int8.onnx', bytes: 36_416_150 },
      { path: 'vector_estimator.int8.onnx', bytes: 78_400_833 },
      { path: 'vocoder.int8.onnx', bytes: 25_991_073 },
      { path: 'tts.json', bytes: 8_253 },
      { path: 'unicode_indexer.bin', bytes: 262_144 },
      { path: 'voice.bin', bytes: 517_168 },
      { path: 'LICENSE', bytes: 1_070 },
      { path: 'README.md', bytes: 19_518 },
    ],
  },
};

/** Catalogue de l'app : dictée (phase 1), puis synthèse (phase 2). */
export const VOICE_MODEL_CATALOG: readonly VoiceCatalogEntry[] = [
  SILERO_VAD,
  PARAKEET_TDT_V3_INT8,
  SUPERTONIC_3_INT8,
];

/**
 * Voix de synthèse : un style d'un modèle du catalogue (`VoiceSettings.ttsVoice`).
 * Plusieurs voix peuvent partager le même modèle téléchargé.
 */
export interface TtsVoice {
  /** Identifiant stable, ex. `supertonic-3-m4` (`DEFAULT_TTS_VOICE`). */
  id: string;
  label: string;
  /** Modèle du catalogue qui porte la voix. */
  modelId: string;
  /** Style dans `voice.bin` (identifiant de locuteur de sherpa-onnx). */
  sid: number;
  /** Langue de la synthèse (BCP 47). */
  lang: string;
  /** Étapes de débruitage (qualité contre délai). */
  numSteps: number;
}

/** Étapes de Supertonic retenues en S2 : 8 (premier son médian 0,54 s, première phrase coupée). */
export const SUPERTONIC_NUM_STEPS = 8;
/**
 * Repli à 5 étapes (0,36 s) si L11 mesure un budget de latence dépassé (ADR-004
 * D7). Constante interne, pas un réglage de l'utilisateur.
 */
export const SUPERTONIC_FALLBACK_NUM_STEPS = 5;

/** Styles de Supertonic 3 dans `voice.bin`, dans l'ordre des identifiants (S2). */
const SUPERTONIC_STYLES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] as const;

/** Voix de l'app. Seule M4, choisie à l'écoute en S2, est proposée. */
export const TTS_VOICES: readonly TtsVoice[] = [
  {
    id: 'supertonic-3-m4',
    label: 'Supertonic 3, voix M4 (français)',
    modelId: SUPERTONIC_3_INT8.id,
    sid: SUPERTONIC_STYLES.indexOf('M4'),
    lang: 'fr',
    numSteps: SUPERTONIC_NUM_STEPS,
  },
];

/** Voix de synthèse, ou `undefined` si l'identifiant est inconnu. */
export function findTtsVoice(
  id: string,
  voices: readonly TtsVoice[] = TTS_VOICES,
): TtsVoice | undefined {
  return voices.find((voice) => voice.id === id);
}

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
