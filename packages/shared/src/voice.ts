/**
 * Voix locale (voir `docs/adr/ADR-004-voix.md`), phase 1 : dictée dans le
 * Composer. La reconnaissance tourne sur le Mac (sherpa-onnx et Parakeet dans un
 * `utilityProcess`) ; l'audio ne quitte jamais le Mac et n'est jamais écrit sur
 * le disque.
 *
 * Types, constantes et fonctions pures, sans dépendance Node : le main, le
 * package `voice` et le renderer partagent les mêmes règles.
 *
 * Sécurité (ADR-004 §7) : la voix n'autorise rien. Un transcript est un message
 * de l'utilisateur, soumis aux mêmes règles que le texte tapé ; aucune
 * permission ni aucun réglage ne se donne à la voix.
 */
import type { SerializedAtelierError } from './errors.js';
import { checkServerUrl } from './llm.js';

/** Rôle d'un modèle de voix. `tts` et `turn` : phase 2. */
export type VoiceModelRole = 'vad' | 'stt' | 'tts' | 'turn';

/**
 * État d'un modèle. `installed` : présent et vérifié sur le disque ;
 * `loaded` : chargé par le moteur.
 */
export type VoiceModelState = 'absent' | 'downloading' | 'installed' | 'loaded' | 'error';

/** Modèle du catalogue (épinglé dans le code de l'app, ADR-004 D5). */
export interface VoiceModelInfo {
  /** Identifiant stable, ex. `parakeet-tdt-0.6b-v3-int8`. */
  id: string;
  role: VoiceModelRole;
  /** Libellé français, ex. « Parakeet v3 (25 langues européennes) ». */
  label: string;
  version: string;
  /** Langues BCP 47 prises en charge (`fr`, `nl`, `en`…). */
  languages: readonly string[];
  /** Taille de l'archive téléchargée, en octets. */
  downloadBytes: number;
  /** Place occupée une fois installé, en octets. */
  diskBytes: number;
  /** Mémoire résidente estimée une fois chargé, en octets. */
  memoryEstimateBytes: number;
  /** Identifiant SPDX de la licence, ex. `CC-BY-4.0`. */
  license: string;
  /** Attribution exigée par la licence (« À propos › Licences »). */
  attribution?: string;
  /** Embarqué dans l'app (détection de parole), jamais téléchargé. */
  bundled: boolean;
  state: VoiceModelState;
  /** Progression, pendant `downloading`. */
  progress?: { receivedBytes: number; totalBytes: number };
  /** Dernière erreur, pendant `error` (`voice/model_invalid`, `voice/download_failed`…). */
  error?: SerializedAtelierError;
}

/** Autorisation macOS du micro (`systemPreferences.getMediaAccessStatus`). */
export type MicAccess = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

/** État du process de reconnaissance. `stopped` : non lancé ou déchargé après inactivité. */
export type VoiceEngineState = 'stopped' | 'loading' | 'ready' | 'error';

/** État global de la voix (Réglages › Voix, bouton micro). */
export interface VoiceStatus {
  mic: MicAccess;
  engine: VoiceEngineState;
  models: VoiceModelInfo[];
}

/** Mode d'une session vocale. `conversation` : phase 2 (L6). */
export type VoiceMode = 'dictation' | 'conversation';

/**
 * État d'une session vocale.
 * - `starting` : micro en cours d'ouverture, aucune trame reçue. L'interface
 *   n'invite pas encore à parler : S1 a mesuré 0,55 à 0,98 s perdues entre le
 *   clic et la première trame, première cause d'erreur de la dictée.
 * - `listening` : la première trame est arrivée, l'utilisateur peut parler.
 * - `transcribing` : arrêt demandé, dernier segment en cours de décodage.
 * - `idle` : session terminée.
 * - `thinking`, `speaking`, `waiting_permission` : phase 2.
 */
export type VoiceSessionState =
  | 'starting'
  | 'listening'
  | 'transcribing'
  | 'idle'
  | 'thinking'
  | 'speaking'
  | 'waiting_permission';

/**
 * Alerte sur l'entrée audio, pendant `listening` : `silent_input` quand les
 * trames sont entièrement nulles depuis au moins {@link VOICE_SILENT_INPUT_MS}
 * (S1 : micro muet pendant 10 min sans aucun signal).
 */
export type VoiceInputWarning = 'silent_input';

/** Segment transcrit, émis à chaque pause (détection de parole). */
export interface TranscriptSegment {
  voiceSessionId: string;
  /** Rang du segment dans la session, à partir de 0. */
  index: number;
  text: string;
  /** Vrai quand le segment ne changera plus. */
  final: boolean;
  /** Bornes du segment depuis le début de la session, en millisecondes. */
  startMs: number;
  endMs: number;
}

/** Réglages de la voix (`AppSettings.voice`, absent = {@link DEFAULT_VOICE_SETTINGS}). */
export interface VoiceSettings {
  enabled: boolean;
  /** Identifiant du modèle de reconnaissance (catalogue). */
  sttModel: string;
  /** Minutes d'inactivité avant de décharger le moteur ; `0` = le garder chargé. */
  idleUnloadMinutes: number;
  /**
   * Miroir des modèles : https, ou http pour localhost et Tailscale (règle de
   * `checkServerUrl`). Absent : source officielle. L'empreinte SHA-256 reste
   * celle du catalogue de l'app, jamais lue sur le serveur.
   */
  modelSourceUrl?: string;
  /** Micro choisi (`MediaDeviceInfo.deviceId`) ; absent : micro par défaut. */
  inputDeviceId?: string;
  /**
   * Mots à mieux reconnaître (noms propres, marques : « Ollama », « Triptyk »),
   * principale source d'erreurs mesurée en S1. Au plus {@link MAX_VOICE_GLOSSARY_TERMS}.
   */
  glossary?: string[];
  // Phase 2 (L6) : voix, vitesse, interruption à la voix, silence de fin de tour.
  ttsVoice?: string;
  /** Vitesse de la synthèse, de 0,8 à 1,3. */
  ttsRate?: number;
  bargeIn?: boolean;
  endOfTurnSilenceMs?: number;
}

/** Fréquence d'échantillonnage des trames du micro (PCM mono). */
export const VOICE_SAMPLE_RATE = 16_000;
/** Durée d'une trame envoyée par `voice:audio`. */
export const VOICE_FRAME_MS = 100;
/** Échantillons par trame (1 600 à 16 kHz). */
export const VOICE_FRAME_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000;
/**
 * Audio gardé avant le début de chaque segment détecté, pour ne pas couper la
 * première syllabe (S1 : récupère « Lance » en début de phrase).
 */
export const VOICE_PRE_ROLL_MS = 300;
/** Durée de trames nulles au-delà de laquelle `silent_input` est signalé. */
export const VOICE_SILENT_INPUT_MS = 1_000;
/** Arrêt automatique d'une dictée. */
export const MAX_DICTATION_MS = 5 * 60 * 1000;
/** Termes du glossaire. */
export const MAX_VOICE_GLOSSARY_TERMS = 200;
export const MAX_VOICE_GLOSSARY_TERM_CHARS = 60;
/** Inactivité maximale réglable avant déchargement (24 h). */
export const MAX_VOICE_IDLE_UNLOAD_MINUTES = 1_440;
/** Modèle de reconnaissance par défaut (ADR-004 D4, confirmé par S1). */
export const DEFAULT_STT_MODEL = 'parakeet-tdt-0.6b-v3-int8';

/** Réglages par défaut : voix désactivée tant que l'utilisateur ne l'a pas activée. */
export const DEFAULT_VOICE_SETTINGS: Readonly<VoiceSettings> = {
  enabled: false,
  sttModel: DEFAULT_STT_MODEL,
  idleUnloadMinutes: 10,
};

/** Problème d'un réglage de la voix (message français, affiché tel quel). */
export interface VoiceSettingsIssue {
  field: keyof VoiceSettings;
  message: string;
}

/**
 * Valide les réglages de la voix (phase 1). Renvoie le premier problème, ou
 * `undefined`. Défensive : la valeur peut venir de l'IPC.
 */
export function validateVoiceSettings(settings: VoiceSettings): VoiceSettingsIssue | undefined {
  if (typeof settings.sttModel !== 'string' || settings.sttModel.trim() === '') {
    return { field: 'sttModel', message: 'Choisissez un modèle de reconnaissance.' };
  }
  const idle = settings.idleUnloadMinutes;
  if (!Number.isInteger(idle) || idle < 0 || idle > MAX_VOICE_IDLE_UNLOAD_MINUTES) {
    return {
      field: 'idleUnloadMinutes',
      message: `Le délai de libération de la mémoire doit être un nombre entier de minutes, entre 0 et ${String(MAX_VOICE_IDLE_UNLOAD_MINUTES)}.`,
    };
  }
  if (settings.modelSourceUrl !== undefined && settings.modelSourceUrl.trim() !== '') {
    const check = checkServerUrl(settings.modelSourceUrl);
    if (!check.ok) {
      return {
        field: 'modelSourceUrl',
        message:
          check.reason === 'insecure_http'
            ? 'Le miroir des modèles doit être en https:// (http:// seulement pour localhost ou Tailscale).'
            : 'Adresse du miroir des modèles invalide.',
      };
    }
  }
  if (settings.glossary !== undefined) {
    if (settings.glossary.length > MAX_VOICE_GLOSSARY_TERMS) {
      return {
        field: 'glossary',
        message: `Le glossaire compte au plus ${String(MAX_VOICE_GLOSSARY_TERMS)} termes.`,
      };
    }
    for (const term of settings.glossary) {
      if (typeof term !== 'string' || term.trim() === '') {
        return { field: 'glossary', message: 'Le glossaire contient un terme vide.' };
      }
      if (term.length > MAX_VOICE_GLOSSARY_TERM_CHARS) {
        return {
          field: 'glossary',
          message: `Le terme « ${term.slice(0, 20)}… » dépasse ${String(MAX_VOICE_GLOSSARY_TERM_CHARS)} caractères.`,
        };
      }
    }
  }
  return undefined;
}
