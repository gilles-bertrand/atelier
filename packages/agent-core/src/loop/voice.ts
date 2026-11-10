/**
 * Mode vocal (ADR-004, D7, lot L8) : consignes ajoutées au tour, thinking coupé
 * et phrases d'attente prononcées pendant les outils longs, sans LLM.
 *
 * Un tour est vocal quand le message de l'utilisateur a `inputMode: 'voice'`
 * (la dictée, relue avant l'envoi, reste un tour normal) : l'app le signale par
 * `SendOptions.voice` (L9).
 */
import type { ModelMessage } from 'ai';
import { APP_MESSAGE_PREFIX, injectedKind, injectedMessage } from './compaction.js';

/** Consignes du mode vocal, texte exact de l'ADR-004 (D7). */
export const VOICE_MODE_INSTRUCTIONS =
  "Mode vocal : l'utilisateur t'écoute au lieu de lire. Réponds en français parlé, en une à trois phrases courtes, sans markdown, liste, tableau ni emoji. Ne lis jamais une URL, un chemin complet ou du code : dis ce que c'est (« le fichier des ventes de mars »). Si la réponse est longue, écris-la dans un fichier et résume-la en une phrase. Si tu as besoin d'une autorisation, dis que l'utilisateur doit la donner à l'écran.";

/** Retour à l'écrit après des tours vocaux : les consignes vocales restent dans l'historique. */
export const VOICE_MODE_END =
  "Fin du mode vocal : l'utilisateur lit de nouveau tes réponses à l'écran. Reprends ta présentation habituelle.";

/** Message injecté après le message de l'utilisateur d'un tour vocal. */
export function voiceInstructionsMessage(): ModelMessage {
  return injectedMessage('voice', `${APP_MESSAGE_PREFIX} ${VOICE_MODE_INSTRUCTIONS}`);
}

/** Message injecté au premier tour écrit qui suit un tour vocal. */
export function voiceEndMessage(): ModelMessage {
  return injectedMessage('voice_end', `${APP_MESSAGE_PREFIX} ${VOICE_MODE_END}`);
}

/**
 * Messages du mode vocal à ajouter au tour, après le message de l'utilisateur.
 *
 * Les consignes vont dans le tour et non dans le prompt système : celui-ci,
 * identique d'un tour à l'autre, reste en tête du cache de préfixe d'Ollama
 * (budget de latence de D7). Elles restent dans l'historique, qui n'est jamais
 * réécrit : un tour écrit qui suit un tour vocal reçoit donc une consigne de fin.
 */
export function voiceTurnMessages(
  history: readonly ModelMessage[],
  voice: boolean,
): ModelMessage[] {
  if (voice) return [voiceInstructionsMessage()];
  return lastVoiceMarker(history) === 'voice' ? [voiceEndMessage()] : [];
}

/** Dernier marqueur vocal de l'historique (`voice` ou `voice_end`), s'il y en a un. */
function lastVoiceMarker(history: readonly ModelMessage[]): 'voice' | 'voice_end' | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    const kind = message ? injectedKind(message) : undefined;
    if (kind === 'voice' || kind === 'voice_end') return kind;
  }
  return undefined;
}

/**
 * Options fournisseur qui coupent le thinking de Qwen pour une requête, quel que
 * soit le modèle configuré : même effet que `disableThinking` (provider), par la
 * voie `providerOptions` du provider OpenAI-compatible nommé `ollama`.
 */
export const THINKING_OFF_PROVIDER_OPTIONS = {
  ollama: { reasoningEffort: 'none', chat_template_kwargs: { enable_thinking: false } },
} as const;

// --- Phrases d'attente des outils -------------------------------------------

/** Délai avant la phrase d'attente d'un outil en cours (ms, D7). */
export const TOOL_WAIT_DELAY_MS = 1_500;
/** Écart minimal entre deux phrases d'attente (ms, D7). */
export const TOOL_WAIT_MIN_INTERVAL_MS = 5_000;

/** Phrase d'attente prête à être prononcée (L9 l'envoie à la synthèse). */
export interface ToolWaitPhrase {
  toolCallId: string;
  toolName: string;
  /** Phrase courte en français (« Je lis ventes.csv. »). */
  text: string;
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Dernier segment d'un chemin : on ne prononce jamais un chemin complet (D7). */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Nom de fichier prononçable, ou `undefined` (vide, ou trop long pour une phrase). */
function spokenFileName(input: unknown): string | undefined {
  const path = field(input, 'path');
  if (!path || path === '.') return undefined;
  const name = baseName(path);
  return name.length <= 40 ? name : undefined;
}

/**
 * Phrase d'attente d'un outil, tirée de son libellé natif (`toolLabel` de
 * l'interface), à la première personne. Jamais d'URL, de chemin complet, de
 * commande ni de motif de recherche : seulement ce que fait l'outil.
 */
export function toolWaitPhrase(toolName: string, input: unknown): string {
  const name = spokenFileName(input);
  switch (toolName) {
    case 'read_file':
      if (name === 'SKILL.md') return 'Je consulte un skill.';
      return name ? `Je lis ${name}.` : 'Je lis un fichier.';
    case 'write_file':
      return name ? `J'écris ${name}.` : "J'écris un fichier.";
    case 'edit_file':
      return name ? `Je modifie ${name}.` : 'Je modifie un fichier.';
    case 'list_dir':
      return 'Je regarde le contenu du dossier.';
    case 'glob':
      return 'Je cherche des fichiers.';
    case 'grep':
      return 'Je cherche dans les fichiers.';
    case 'bash':
      return 'Je lance une commande.';
    case 'todo_write':
      return 'Je mets à jour mes tâches.';
    case 'present_file':
      return name ? `Je prépare ${name}.` : 'Je prépare le fichier.';
    case 'look_at':
      return "J'analyse l'image.";
    case 'web_search':
      return 'Je cherche sur le web.';
    case 'web_fetch':
      return 'Je lis une page web.';
    case 'tool_search':
      return 'Je cherche un connecteur.';
    case 'memory_add':
    case 'memory_rewrite':
      return 'Je mets à jour la mémoire du projet.';
    case 'publish_artifact':
      return "Je publie l'artefact.";
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      const server = mcp?.[1]?.replace(/[_-]+/g, ' ').trim();
      return server ? `J'utilise le connecteur ${server}.` : 'Je travaille.';
    }
  }
}

/** Minuterie injectable (tests : horloge simulée). */
export interface VoiceTimers {
  /** Instant courant, en ms (monotone). */
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Minuterie réelle. */
export const systemVoiceTimers: VoiceTimers = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface ToolWaitAnnouncerOptions {
  /** Reçoit chaque phrase à prononcer. */
  onPhrase: (phrase: ToolWaitPhrase) => void;
  timers?: VoiceTimers;
  /** Défaut {@link TOOL_WAIT_DELAY_MS}. */
  delayMs?: number;
  /** Défaut {@link TOOL_WAIT_MIN_INTERVAL_MS}. */
  minIntervalMs?: number;
  /** Erreur levée par `onPhrase` : journalisée, jamais propagée à l'outil. */
  onError?: (error: unknown) => void;
}

interface RunningTool {
  toolName: string;
  input: unknown;
  handle: unknown;
}

/**
 * Rythme des phrases d'attente d'un tour vocal :
 * - une phrase quand un outil dure plus de `delayMs` (1,5 s) ;
 * - au plus une phrase toutes les `minIntervalMs` (5 s) : un outil qui atteint
 *   son délai trop tôt après la phrase précédente attend la fin de cet écart,
 *   et ne dit rien s'il se termine avant ;
 * - une phrase au plus par appel d'outil.
 *
 * Le temps passé à attendre une permission n'est pas compté : la minuterie
 * démarre quand l'outil s'exécute vraiment (voir `ToolRuntime.onExecution`).
 */
export class ToolWaitAnnouncer {
  readonly #onPhrase: (phrase: ToolWaitPhrase) => void;
  readonly #timers: VoiceTimers;
  readonly #delayMs: number;
  readonly #minIntervalMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #running = new Map<string, RunningTool>();
  #lastSpokenAt: number | undefined;
  #disposed = false;

  constructor(options: ToolWaitAnnouncerOptions) {
    this.#onPhrase = options.onPhrase;
    this.#timers = options.timers ?? systemVoiceTimers;
    this.#delayMs = options.delayMs ?? TOOL_WAIT_DELAY_MS;
    this.#minIntervalMs = options.minIntervalMs ?? TOOL_WAIT_MIN_INTERVAL_MS;
    this.#onError = options.onError;
  }

  /** Un outil commence à s'exécuter. */
  start(toolCallId: string, toolName: string, input: unknown): void {
    if (this.#disposed) return;
    this.end(toolCallId);
    const handle = this.#timers.setTimeout(() => {
      this.#due(toolCallId);
    }, this.#delayMs);
    this.#running.set(toolCallId, { toolName, input, handle });
  }

  /** L'outil a fini (résultat, erreur ou abandon) : sa phrase n'est plus dite. */
  end(toolCallId: string): void {
    const running = this.#running.get(toolCallId);
    if (!running) return;
    this.#timers.clearTimeout(running.handle);
    this.#running.delete(toolCallId);
  }

  /** Fin du tour : plus aucune phrase. */
  dispose(): void {
    this.#disposed = true;
    for (const id of [...this.#running.keys()]) this.end(id);
  }

  #due(toolCallId: string): void {
    const running = this.#running.get(toolCallId);
    if (!running || this.#disposed) return;
    const now = this.#timers.now();
    const wait =
      this.#lastSpokenAt === undefined ? 0 : this.#lastSpokenAt + this.#minIntervalMs - now;
    if (wait > 0) {
      running.handle = this.#timers.setTimeout(() => {
        this.#due(toolCallId);
      }, wait);
      return;
    }
    this.#running.delete(toolCallId);
    this.#lastSpokenAt = now;
    try {
      this.#onPhrase({
        toolCallId,
        toolName: running.toolName,
        text: toolWaitPhrase(running.toolName, running.input),
      });
    } catch (error) {
      this.#onError?.(error);
    }
  }
}
