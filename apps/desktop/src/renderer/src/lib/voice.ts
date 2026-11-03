/**
 * Dictée (ADR-004 D6) : fonctions pures du renderer, sans React ni IPC.
 * Insertion du texte dicté au curseur, niveau du vu-mètre, chronomètre,
 * raccourci, préparation (micro autorisé, modèle installé).
 */
import {
  DEFAULT_STT_MODEL,
  type MicAccess,
  type VoiceModelInfo,
  type VoiceSettings,
  type VoiceStatus,
} from '@atelier/shared';
// Fonctions pures, sans dépendance : le renderer n'importe que ce module de la voix.
import { assembleSegments } from '@atelier/voice/typography';

/** Texte composé et position du curseur après le texte dicté. */
export interface ComposedText {
  value: string;
  /** Fin du texte dicté (curseur). */
  cursor: number;
}

/** Ponctuation qui se colle au mot précédent (pas d'espace avant le texte qui suit). */
const NO_SPACE_BEFORE = /^[\s,.;:!?)\]}»…'’\u00a0\u202f]/;

/**
 * Insère `dictated` entre `before` et `after` (le texte autour du curseur au
 * début de la dictée), en ajoutant une espace de chaque côté si besoin.
 */
export function composeDictation(before: string, dictated: string, after: string): ComposedText {
  const text = dictated.trim();
  if (text === '') return { value: before + after, cursor: before.length };
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const trail = after !== '' && !NO_SPACE_BEFORE.test(after) ? ' ' : '';
  const head = before + lead + text;
  return { value: head + trail + after, cursor: head.length };
}

/**
 * Assemble les segments reçus (à chaque pause), dans l'ordre de leur rang,
 * comme le texte final du worker : le point d'une pause au milieu d'une phrase
 * est retiré (#42).
 */
export function joinSegments(segments: readonly (string | undefined)[]): string {
  return assembleSegments(Array.from(segments, (s) => s ?? ''));
}

/**
 * Niveau du vu-mètre (0 à 1) d'une trame PCM : RMS en décibels, ramené
 * linéairement de -60 dBFS (silence) à 0 dBFS.
 */
export function micLevel(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const v of pcm) sum += v * v;
  const rms = Math.sqrt(sum / pcm.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/** Chronomètre : « 0:07 », « 4:59 ». */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

/** Durée parlée pour VoiceOver : « 1 minute 7 secondes ». */
export function spokenElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${String(minutes)} minute${minutes > 1 ? 's' : ''}`);
  parts.push(`${String(seconds)} seconde${seconds > 1 ? 's' : ''}`);
  return parts.join(' ');
}

/** Taille annoncée d'un téléchargement, arrondie à 10 Mo : « environ 490 Mo ». */
export function approxDownloadSize(bytes: number): string {
  const mo = Math.max(10, Math.round(bytes / 10_000_000) * 10);
  return `environ ${new Intl.NumberFormat('fr-FR').format(mo)} Mo`;
}

/** Raccourci de la dictée : ⌘⇧D (libre : ⌘K, ⌘B et ⌘N sont sans Maj). */
export function isDictationShortcut(event: {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (
    event.metaKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    event.key.toLowerCase() === 'd'
  );
}

export const DICTATION_SHORTCUT_LABEL = '⌘⇧D';

/** Modèle de reconnaissance choisi dans les réglages, s'il est au catalogue. */
export function sttModelOf(
  status: VoiceStatus | undefined,
  settings: Pick<VoiceSettings, 'sttModel'> | undefined,
): VoiceModelInfo | undefined {
  const id = settings?.sttModel ?? DEFAULT_STT_MODEL;
  return status?.models.find((m) => m.id === id);
}

/** Le modèle est sur le disque, vérifié (ou déjà chargé). */
export function isModelReady(model: VoiceModelInfo | undefined): boolean {
  return model?.state === 'installed' || model?.state === 'loaded';
}

/** Accès au micro refusé par macOS (ou par une règle de l'entreprise). */
export function isMicBlocked(access: MicAccess): boolean {
  return access === 'denied' || access === 'restricted';
}

/** Ce qui manque avant de dicter. */
export type DictationBlocker = 'mic_denied' | 'model' | undefined;

/**
 * Prérequis de la dictée, dans l'ordre où l'utilisateur les règle : micro
 * autorisé, puis modèle installé. `not-determined` n'est pas bloquant : la
 * demande de macOS part au clic.
 */
export function dictationBlocker(
  status: VoiceStatus,
  settings: Pick<VoiceSettings, 'sttModel'> | undefined,
): DictationBlocker {
  if (isMicBlocked(status.mic)) return 'mic_denied';
  if (!isModelReady(sttModelOf(status, settings))) return 'model';
  return undefined;
}

/** Libellé de l'état d'un modèle (Réglages › Voix). */
export function modelStateLabel(model: VoiceModelInfo): string {
  if (model.bundled) return 'Intégré à l’app';
  switch (model.state) {
    case 'absent':
      return 'Non téléchargé';
    case 'downloading':
      return 'Téléchargement…';
    case 'installed':
      return 'Installé';
    case 'loaded':
      return 'Installé, chargé en mémoire';
    case 'error':
      return 'En erreur';
  }
}

/** Progression d'un téléchargement (0 à 1), si elle est connue. */
export function downloadRatio(model: VoiceModelInfo): number | undefined {
  const progress = model.progress;
  if (!progress || progress.totalBytes <= 0) return undefined;
  return Math.min(1, progress.receivedBytes / progress.totalBytes);
}
