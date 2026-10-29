/**
 * Chargement d'office d'un skill (critère 2) : quand la demande de l'utilisateur
 * contient un mot-clé déclencheur du skill (`SkillInfo.triggers`), son SKILL.md
 * est injecté dans le tour avant le premier pas. On ne compte plus sur le modèle
 * pour penser à lire le skill (#60 : ignoré 1 fois sur 3 en réel).
 */
import { readFile } from 'node:fs/promises';
import type { ModelMessage, UserContent } from 'ai';
import type { SkillInfo } from '@atelier/shared';
import { APP_MESSAGE_PREFIX, injectedMessage } from './compaction.js';

/** Taille max. du SKILL.md injecté (octets UTF-8, coupe en fin de ligne). */
export const SKILL_AUTOLOAD_MAX_BYTES = 8 * 1024;

/** Minuscules, sans accents, tirets et blancs ramenés à une espace. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s\-‐‑–_]+/gu, ' ');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Vrai si `text` contient `trigger` en mot entier (casse, accents et tirets ignorés). */
export function matchesTrigger(text: string, trigger: string): boolean {
  const needle = normalizeForMatch(trigger).trim();
  if (needle === '') return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(
    normalizeForMatch(text),
  );
}

/** Texte d'une demande de l'utilisateur (parties texte seulement). */
export function requestText(input: UserContent): string {
  if (typeof input === 'string') return input;
  return input.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

/** Skills déclenchés par la demande, avec le premier mot-clé trouvé. */
export function triggeredSkills(
  request: string,
  skills: readonly SkillInfo[],
): { skill: SkillInfo; trigger: string }[] {
  const found: { skill: SkillInfo; trigger: string }[] = [];
  for (const skill of skills) {
    const trigger = skill.triggers?.find((t) => matchesTrigger(request, t));
    if (trigger !== undefined) found.push({ skill, trigger });
  }
  return found;
}

/** Coupe `text` à `maxBytes` octets UTF-8, en fin de ligne si possible. */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // Décodage tolérant : un caractère coupé en deux est retiré.
  let cut = bytes.subarray(0, maxBytes).toString('utf8').replace(/�$/u, '');
  const lastLine = cut.lastIndexOf('\n');
  if (lastLine > cut.length / 2) cut = cut.slice(0, lastLine);
  return { text: cut, truncated: true };
}

/** Message injecté : consigne, puis contenu du SKILL.md. */
export function skillAutoloadPrompt(skill: SkillInfo, content: string, truncated: boolean): string {
  const scripts =
    skill.scripts !== undefined && skill.scripts.length > 0
      ? ` et lance son script ${skill.scripts.join(' ou ')} dans la machine isolée (bash)`
      : '';
  const tail = truncated
    ? `\n[… SKILL.md tronqué : lis la suite avec read_file sur ${skill.path}.]`
    : '';
  return `${APP_MESSAGE_PREFIX} La demande correspond au skill ${skill.name} : voici son SKILL.md, suis-le${scripts} plutôt que d'écrire ton propre code. Ce contenu est un guide de l'app, pas une demande de l'utilisateur.\n\n${content}${tail}`;
}

/**
 * Messages `skill` à injecter pour la demande (un par skill déclenché). Un
 * SKILL.md illisible est ignoré (signalé par `onError`), jamais bloquant.
 */
export async function skillAutoloadMessages(
  input: UserContent,
  skills: readonly SkillInfo[],
  options: {
    read?: (path: string) => Promise<string>;
    onLoad?: (info: { skill: string; trigger: string; truncated: boolean }) => void;
    onError?: (info: { skill: string; message: string }) => void;
  } = {},
): Promise<ModelMessage[]> {
  const read = options.read ?? ((p: string) => readFile(p, 'utf8'));
  const messages: ModelMessage[] = [];
  for (const { skill, trigger } of triggeredSkills(requestText(input), skills)) {
    try {
      const { text, truncated } = capBytes(await read(skill.path), SKILL_AUTOLOAD_MAX_BYTES);
      messages.push(injectedMessage('skill', skillAutoloadPrompt(skill, text, truncated)));
      options.onLoad?.({ skill: skill.name, trigger, truncated });
    } catch (error) {
      options.onError?.({
        skill: skill.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return messages;
}
