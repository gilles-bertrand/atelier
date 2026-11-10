/**
 * Mode conversation côté main (ADR-004 D7, §7, lot L9) : orchestration des
 * tours de parole, en semi-duplex (S3).
 *
 * - **Écoute** : une session de reconnaissance par tour de l'utilisateur. Le
 *   worker signale la fin du tour après `endOfTurnSilenceMs` de silence ; le
 *   texte final part comme message de l'utilisateur (`inputMode: 'voice'`).
 * - **Voix** : le texte de l'agent passe par `AgentSpeech` (L7) ; chaque
 *   morceau sort en `voice:audio-out`. Une réponse peut compter plusieurs
 *   « énoncés » dans le même tour (texte avant un outil, phrase d'attente,
 *   annonce de permission, réponse finale), chacun clos par un morceau
 *   `final` ; ils sont joués l'un après l'autre, sans se couper.
 * - **Semi-duplex** : tant que l'agent parle, puis pendant
 *   `VOICE_ECHO_GUARD_MS` après `voice:playback-ended`, les trames du micro ne
 *   vont pas à la détection de parole. Le micro du renderer reste ouvert.
 * - **Pendant que l'agent travaille en silence** : une phrase dite est mise en
 *   file, envoyée quand le tour et sa voix sont terminés ; « stop »,
 *   « arrête » ou « annule », dits seuls, arrêtent le tour.
 * - **Interruption** : seulement par `voice:interrupt` (bouton ou raccourci).
 * - **Permission** : l'agent dit « Il me faut votre accord à l'écran. », puis
 *   l'écoute est suspendue jusqu'à la réponse à l'écran. Aucune permission ne
 *   se donne à la voix (§7) : le transcript n'atteint jamais le broker.
 * - **Fin** : `end()` (bouton, Échap, fenêtre, veille, via `VoiceService`), ou
 *   `VOICE_CONVERSATION_IDLE_MS` sans parole pendant l'écoute.
 *
 * Electron n'est pas importé : reconnaissance, synthèse, agent et horloge sont
 * injectés. Confidentialité (D9) : ni audio, ni transcript, ni texte de
 * l'agent dans les journaux ; seuls des codes et des compteurs y vont.
 */
import {
  AtelierError,
  DEFAULT_END_OF_TURN_SILENCE_MS,
  VOICE_CONVERSATION_IDLE_MS,
  VOICE_ECHO_GUARD_MS,
  type AgentEvent,
  type IpcEventChannel,
  type IpcEventPayload,
  type PermissionRequest,
  type TranscriptSegment,
  type VoiceAudioOut,
  type VoiceInputWarning,
  type VoiceSessionState,
} from '@atelier/shared';
import type { ToolWaitPhrase } from '@atelier/agent-core';

/** Phrase dite quand l'agent attend une permission (ADR-004 D7, Permission). */
export const PERMISSION_PHRASE = 'Il me faut votre accord à l’écran.';

/**
 * Durée maximale d'une session d'écoute : pendant un long tour de l'agent, le
 * micro écoute sans fin (file d'attente, « stop »). Borne du protocole (1 h).
 */
export const CONVERSATION_LISTEN_MAX_MS = 60 * 60 * 1000;

/**
 * Marge après la fin prévue de la voix (durée de l'audio envoyé) au-delà de
 * laquelle la lecture est tenue pour terminée sans `voice:playback-ended` :
 * un renderer muet ne doit pas laisser le micro coupé pour toujours.
 */
export const PLAYBACK_ENDED_GRACE_MS = 5_000;

/** Ordres d'arrêt reconnus, dits seuls (ADR-004 D7). */
const STOP_WORDS = new Set(['stop', 'arrete', 'annule']);

/**
 * Vrai si le transcript est un ordre d'arrêt dit seul : « Stop. »,
 * « Arrête ! », « annule », sans autre mot. Casse, accents et ponctuation
 * ignorés.
 */
export function isStopCommand(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return STOP_WORDS.has(normalized);
}

/** Reconnaissance vue par l'orchestrateur (le superviseur du worker). */
export interface ConversationListener {
  start(
    listenId: string,
    options: { maxDurationMs: number; endOfTurnSilenceMs: number },
  ): Promise<void>;
  /** Termine la session d'écoute et rend son texte final. */
  stop(listenId: string): Promise<string>;
  cancel(listenId: string): void;
  audio(listenId: string, seq: number, pcm: Float32Array): void;
}

/** Voix de l'agent (`AgentSpeech`, L7). */
export interface ConversationSpeech {
  begin(turnId: string): void;
  push(turnId: string, delta: string): void;
  end(turnId: string): void;
  interrupt(): void;
}

/** Sorties de la voix, branchées par l'orchestrateur à la création. */
export interface SpeechSink {
  onAudio: (chunk: VoiceAudioOut) => void;
  onError: (turnId: string, error: AtelierError) => void;
}

/** Agent vu par l'orchestrateur (`ChatManager` et `PermissionBroker`). */
export interface ConversationAgent {
  /** Envoie un tour vocal (`inputMode: 'voice'`) ; `agent/busy` si un tour tourne. */
  send(
    sessionId: string,
    text: string,
    options: { onToolWaitPhrase: (phrase: ToolWaitPhrase) => void },
  ): { turnId: string };
  /** Sémantique de `agent:stop` : tour annulé, permissions en attente refusées. */
  stop(sessionId: string): Promise<void>;
  isRunning(sessionId: string): boolean;
  /** Résolue quand la conversation est de nouveau libre (voir `ChatManager.whenIdle`). */
  whenIdle(sessionId: string): Promise<void>;
  /** Demandes de permission encore ouvertes dans la conversation. */
  pendingPermissions(sessionId: string): number;
}

/** Minuterie injectable (tests : horloge simulée). */
export interface ConversationTimers {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const systemTimers: ConversationTimers = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Raison de la fin du mode conversation (journal, sans contenu). */
export type ConversationEndReason = 'stopped' | 'idle' | 'error';

export interface VoiceConversationOptions {
  voiceSessionId: string;
  /** Conversation de l'app où partent les tours. */
  sessionId: string;
  /** `VoiceSettings.endOfTurnSilenceMs` ; {@link DEFAULT_END_OF_TURN_SILENCE_MS} par défaut. */
  endOfTurnSilenceMs?: number;
  listener: ConversationListener;
  /** Crée la voix de la session, branchée sur l'orchestrateur. */
  createSpeech: (sink: SpeechSink) => ConversationSpeech;
  agent: ConversationAgent;
  emit: <C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>) => void;
  /** Fin décidée par l'orchestrateur lui-même (60 s sans parole, échec de l'écoute). */
  onEnd?: (reason: ConversationEndReason) => void;
  timers?: ConversationTimers;
  /** {@link VOICE_ECHO_GUARD_MS} par défaut. */
  echoGuardMs?: number;
  /** {@link VOICE_CONVERSATION_IDLE_MS} par défaut. */
  idleMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Énoncé de l'agent : texte joué d'un bloc par `AgentSpeech`, clos par un morceau `final`. */
interface Utterance {
  turnId: string;
  parts: string[];
  /** Plus de texte à venir. */
  closed: boolean;
  /** Confié à `AgentSpeech` (seul le premier de la file l'est). */
  started: boolean;
  /** Un morceau non vide est parti : l'agent parle. */
  audible: boolean;
}

/** Orchestrateur d'une session du mode conversation. */
export class VoiceConversation {
  readonly voiceSessionId: string;
  readonly sessionId: string;
  private readonly o: VoiceConversationOptions;
  private readonly timers: ConversationTimers;
  private readonly speech: ConversationSpeech;
  private readonly endOfTurnSilenceMs: number;
  private readonly echoGuardMs: number;
  private readonly idleMs: number;

  private ended = false;
  /** La première trame du micro est arrivée (`starting` → `listening`). */
  private heard = false;
  private warning: VoiceInputWarning | undefined;
  private lastState: VoiceSessionState | undefined;
  private lastWarning: VoiceInputWarning | undefined;

  // --- écoute
  private listenCount = 0;
  private listenId: string | undefined;
  /** La session d'écoute démarre (chargement du moteur). */
  private listenStarting = false;
  /** La session d'écoute se termine (texte final en cours). */
  private listenStopping = false;
  private segmentIndex = 0;

  // --- agent
  /** Tour vocal lancé par l'orchestrateur, jusqu'à ce que la conversation soit libre. */
  private turn: { turnId: string; finishing: boolean } | undefined;
  /** Tour lancé ailleurs (message tapé) dans la même conversation. */
  private foreignTurnId: string | undefined;
  /** Phrases dites pendant que l'agent travaillait, envoyées à la fin du tour. */
  private queue: string[] = [];
  /** Demande de permission ouverte pendant un tour vocal. */
  private permission = false;

  // --- voix
  private utterances: Utterance[] = [];
  /** Dernier morceau `final` audible, en attente de `voice:playback-ended`. */
  private awaitingPlayback: { turnId: string; lastSeq: number } | undefined;
  /** Fin prévue de la lecture (horloge de `timers.now`). */
  private playbackEndsAt = 0;
  private playbackTimer: unknown;
  private guardTimer: unknown;
  private wasSpeaking = false;
  private idleTimer: unknown;

  constructor(options: VoiceConversationOptions) {
    this.o = options;
    this.voiceSessionId = options.voiceSessionId;
    this.sessionId = options.sessionId;
    this.timers = options.timers ?? systemTimers;
    this.endOfTurnSilenceMs = options.endOfTurnSilenceMs ?? DEFAULT_END_OF_TURN_SILENCE_MS;
    this.echoGuardMs = options.echoGuardMs ?? VOICE_ECHO_GUARD_MS;
    this.idleMs = options.idleMs ?? VOICE_CONVERSATION_IDLE_MS;
    this.speech = options.createSpeech({
      onAudio: (chunk) => {
        this.onSpeechAudio(chunk);
      },
      onError: (_turnId, error) => {
        this.log('synthèse vocale en échec', { code: error.code });
      },
    });
  }

  /** Démarre : état `starting`, première session d'écoute, minuterie d'inactivité. */
  begin(): void {
    this.refresh();
  }

  /** Vrai une fois le mode terminé. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** Vrai si la session d'écoute du worker appartient à cette conversation. */
  owns(listenId: string): boolean {
    return listenId.startsWith(`${this.voiceSessionId}#`);
  }

  // ------------------------------------------------------------------ micro

  /** Trame du micro (déjà validée par `VoiceService`). Ignorée pendant la voix de l'agent. */
  audio(seq: number, pcm: Float32Array): void {
    if (this.ended) return;
    if (!this.heard) {
      this.heard = true;
      this.refresh();
    }
    const id = this.listenId;
    if (id === undefined || this.listenStarting || this.listenStopping || !this.micOpen()) return;
    this.o.listener.audio(id, seq, pcm);
  }

  /** État de la session d'écoute (alerte `silent_input` seulement ; le reste est interne). */
  listenState(listenId: string, warning: VoiceInputWarning | undefined): void {
    if (this.ended || listenId !== this.listenId) return;
    this.warning = warning;
    this.refresh();
  }

  /** Segment transcrit d'un tour de l'utilisateur : relayé sous l'identifiant public. */
  transcript(segment: TranscriptSegment): void {
    if (this.ended || segment.voiceSessionId !== this.listenId) return;
    const relayed: TranscriptSegment = {
      ...segment,
      voiceSessionId: this.voiceSessionId,
      index: this.segmentIndex,
    };
    this.segmentIndex += 1;
    this.o.emit('voice:transcript', relayed);
    this.rearmIdle();
  }

  /** L'utilisateur se met à parler : la minuterie d'inactivité repart. */
  speechStarted(listenId: string): void {
    if (this.ended || listenId !== this.listenId) return;
    this.rearmIdle();
  }

  /** Fin du tour de parole (silence de `endOfTurnSilenceMs`) : texte final, puis envoi. */
  turnEnded(listenId: string): void {
    if (this.ended || listenId !== this.listenId || this.listenStopping) return;
    this.listenStopping = true;
    this.o.listener.stop(listenId).then(
      (text) => {
        this.listenClosed(listenId);
        this.utterance(text);
        this.refresh();
      },
      (error: unknown) => {
        this.listenClosed(listenId);
        this.log('transcription du tour en échec', { code: codeOf(error) });
        this.refresh();
      },
    );
  }

  /** Arrêt automatique de la session d'écoute (durée maximale) : son texte compte comme un tour. */
  listenAutoStopped(listenId: string, text: string): void {
    if (this.ended || listenId !== this.listenId) return;
    this.listenClosed(listenId);
    this.utterance(text);
    this.refresh();
  }

  /** Échec de la reconnaissance : le mode se termine (pas de relance en boucle). */
  listenFailed(listenId: string, error: AtelierError): void {
    if (this.ended || listenId !== this.listenId) return;
    this.listenClosed(listenId);
    this.log('écoute en échec', { code: error.code });
    this.finish('error');
  }

  // ------------------------------------------------------------------ agent

  /** Événement de l'agent (toutes conversations) : seuls ceux de `sessionId` comptent. */
  agentEvent(event: AgentEvent): void {
    if (this.ended || event.sessionId !== this.sessionId) return;
    const turn = this.turn;
    if (turn?.turnId !== event.turnId) {
      this.foreignEvent(event);
      return;
    }
    switch (event.type) {
      case 'text_delta':
        if (!turn.finishing) this.say(event.turnId, event.delta, false);
        return;
      case 'tool_start':
        // Le texte d'avant l'outil part tout de suite, sans attendre la suite.
        this.closeUtterance();
        return;
      case 'permission_request':
        this.closeUtterance();
        this.say(event.turnId, PERMISSION_PHRASE, true);
        this.permission = true;
        this.refresh();
        return;
      case 'done':
      case 'error':
        // Le reste du texte est prononcé ; le tour se libère avec `whenIdle` (voir `send`).
        this.closeUtterance();
        this.permission = false;
        turn.finishing = true;
        this.refresh();
        return;
      default:
        return;
    }
  }

  /** Demande de permission close (réponse à l'écran, stop) : l'écoute peut reprendre. */
  permissionSettled(request: PermissionRequest): void {
    if (this.ended || request.sessionId !== this.sessionId) return;
    this.permission = this.o.agent.pendingPermissions(this.sessionId) > 0;
    this.refresh();
  }

  // ------------------------------------------------------------------ voix

  /** Le renderer a fini de jouer la voix jusqu'au morceau `lastSeq`. */
  playbackEnded(turnId: string, lastSeq: number): void {
    const awaiting = this.awaitingPlayback;
    if (this.ended || awaiting === undefined) return;
    if (awaiting.turnId !== turnId || lastSeq < awaiting.lastSeq) return;
    this.clearPlayback();
    this.refresh();
  }

  /**
   * Bouton « Interrompre » ou raccourci : voix coupée, tour arrêté (sémantique
   * de `agent:stop`), file vidée, puis garde d'écho et écoute. Sans effet si
   * l'agent ne parle ni ne travaille.
   */
  interrupt(): void {
    if (this.ended) return;
    if (!this.speaking() && this.turn === undefined && !this.o.agent.isRunning(this.sessionId)) {
      return;
    }
    this.stopTurn();
  }

  /** Fin du mode (bouton, Échap, fenêtre fermée, mise en veille) : rien n'est envoyé. */
  end(): void {
    this.finish('stopped');
  }

  // ------------------------------------------------------------------ interne

  /** Tour lancé ailleurs (message tapé) : pas de voix, mais l'agent est occupé jusqu'à sa fin. */
  private foreignEvent(event: AgentEvent): void {
    if (this.foreignTurnId === event.turnId || !this.o.agent.isRunning(this.sessionId)) return;
    const turnId = event.turnId;
    this.foreignTurnId = turnId;
    void this.o.agent.whenIdle(this.sessionId).then(() => {
      if (this.foreignTurnId === turnId) this.foreignTurnId = undefined;
      this.refresh();
    });
    this.refresh();
  }

  /** Texte final d'un tour de l'utilisateur. */
  private utterance(text: string): void {
    const spoken = text.trim();
    if (this.ended || spoken === '') return;
    if (isStopCommand(spoken)) {
      // « Stop » dit seul : arrête le tour en cours ; sans tour, il n'est pas envoyé.
      if (this.agentBusy()) this.stopTurn();
      return;
    }
    if (this.agentBusy() || this.speaking()) {
      this.queue.push(spoken);
      return;
    }
    this.send(spoken);
  }

  private send(text: string): void {
    const holder = { turnId: '' };
    try {
      const { turnId } = this.o.agent.send(this.sessionId, text, {
        onToolWaitPhrase: (phrase) => {
          this.waitPhrase(holder.turnId, phrase);
        },
      });
      holder.turnId = turnId;
      const turn = { turnId, finishing: false };
      this.turn = turn;
      // `done` part avant que la conversation soit libre : la file attend la vraie fin.
      void this.o.agent.whenIdle(this.sessionId).then(() => {
        if (this.turn !== turn) return;
        this.closeUtterance();
        this.turn = undefined;
        this.permission = false;
        this.refresh();
      });
    } catch (error) {
      if (codeOf(error) === 'agent/busy') {
        // Un tour a démarré entre-temps (message tapé) : la phrase attend sa fin.
        this.queue.unshift(text);
        void this.o.agent.whenIdle(this.sessionId).then(() => {
          this.refresh();
        });
        return;
      }
      this.log('envoi du tour vocal en échec', { code: codeOf(error) });
    }
  }

  /** Phrase d'attente d'un outil long : dite seulement si l'agent se tait. */
  private waitPhrase(turnId: string, phrase: ToolWaitPhrase): void {
    const turn = this.turn;
    if (this.ended || turn?.turnId !== turnId || turn.finishing || this.permission) return;
    if (this.utterances.length > 0 || this.awaitingPlayback !== undefined) return;
    this.say(turnId, phrase.text, true);
  }

  /** Ajoute du texte à l'énoncé ouvert du tour (ou en ouvre un) ; `close` le termine. */
  private say(turnId: string, text: string, close: boolean): void {
    let last = this.utterances.at(-1);
    if (last?.closed !== false || last.turnId !== turnId) {
      last = { turnId, parts: [], closed: false, started: false, audible: false };
      this.utterances.push(last);
    }
    last.parts.push(text);
    if (last.started) this.speech.push(turnId, text);
    if (close) this.closeUtterance();
    else this.pumpSpeech();
  }

  /** Termine l'énoncé ouvert : son reste est prononcé. */
  private closeUtterance(): void {
    const last = this.utterances.at(-1);
    if (last === undefined || last.closed) return;
    last.closed = true;
    if (last.started) this.speech.end(last.turnId);
    this.pumpSpeech();
  }

  /** Confie le premier énoncé de la file à `AgentSpeech`, s'il ne l'est pas déjà. */
  private pumpSpeech(): void {
    const first = this.utterances[0];
    if (first === undefined || first.started || this.ended) return;
    first.started = true;
    this.speech.begin(first.turnId);
    this.speech.push(first.turnId, first.parts.join(''));
    if (first.closed) this.speech.end(first.turnId);
  }

  private onSpeechAudio(chunk: VoiceAudioOut): void {
    const current = this.utterances[0];
    if (this.ended || current?.started !== true || current.turnId !== chunk.turnId) return;
    this.o.emit('voice:audio-out', chunk);
    if (chunk.pcm.length > 0 && chunk.sampleRate > 0) {
      current.audible = true;
      const now = this.timers.now();
      this.playbackEndsAt =
        Math.max(now, this.playbackEndsAt) + (chunk.pcm.length * 1000) / chunk.sampleRate;
    }
    if (chunk.final) {
      this.utterances.shift();
      if (current.audible) {
        this.awaitingPlayback = { turnId: chunk.turnId, lastSeq: chunk.seq };
        this.armPlaybackFallback();
      }
      this.pumpSpeech();
    }
    this.refresh();
  }

  /** Sans `voice:playback-ended` après la fin prévue de la voix, la lecture est tenue pour finie. */
  private armPlaybackFallback(): void {
    this.clearTimer(this.playbackTimer);
    const wait = Math.max(0, this.playbackEndsAt - this.timers.now()) + PLAYBACK_ENDED_GRACE_MS;
    this.playbackTimer = this.timers.setTimeout(() => {
      this.playbackTimer = undefined;
      if (this.awaitingPlayback === undefined) return;
      this.log('fin de lecture non signalée par le renderer');
      this.awaitingPlayback = undefined;
      this.refresh();
    }, wait);
  }

  private clearPlayback(): void {
    this.awaitingPlayback = undefined;
    this.clearTimer(this.playbackTimer);
    this.playbackTimer = undefined;
  }

  /** Coupe la voix, arrête le tour et vide la file (interruption, « stop »). */
  private stopTurn(): void {
    this.speech.interrupt();
    this.utterances = [];
    this.clearPlayback();
    this.queue = [];
    this.permission = false;
    if (this.turn !== undefined) this.turn.finishing = true;
    if (this.turn !== undefined || this.o.agent.isRunning(this.sessionId)) {
      this.o.agent.stop(this.sessionId).catch((error: unknown) => {
        this.log('arrêt du tour en échec', { code: codeOf(error) });
      });
    }
    this.refresh();
  }

  /** L'agent parle : un énoncé audible en cours, ou une voix pas encore jouée jusqu'au bout. */
  private speaking(): boolean {
    return this.utterances[0]?.audible === true || this.awaitingPlayback !== undefined;
  }

  private agentBusy(): boolean {
    return (
      this.turn !== undefined ||
      this.foreignTurnId !== undefined ||
      this.permission ||
      this.o.agent.isRunning(this.sessionId)
    );
  }

  /** Les trames du micro vont à la détection de parole (semi-duplex, S3 ; permission, D7). */
  private micOpen(): boolean {
    return !this.ended && !this.speaking() && this.guardTimer === undefined && !this.permission;
  }

  private deriveState(): VoiceSessionState {
    if (this.speaking() || this.guardTimer !== undefined) return 'speaking';
    if (this.permission) return 'waiting_permission';
    if (this.turn !== undefined || this.foreignTurnId !== undefined) return 'thinking';
    return this.heard ? 'listening' : 'starting';
  }

  /** Recalcule tout après un changement : garde d'écho, écoute, file, état, inactivité. */
  private refresh(): void {
    if (this.ended) return;
    const speaking = this.speaking();
    if (this.wasSpeaking && !speaking) this.startGuard();
    this.wasSpeaking = speaking;

    // File : la phrase mise en attente part quand le tour et sa voix sont finis.
    if (this.queue.length > 0 && !this.agentBusy() && !speaking) {
      const text = this.queue.join(' ');
      this.queue = [];
      this.send(text);
    }

    this.syncListening();

    const state = this.deriveState();
    const warning = state === 'listening' ? this.warning : undefined;
    if (state !== this.lastState || warning !== this.lastWarning) {
      const entering = state !== this.lastState;
      this.lastState = state;
      this.lastWarning = warning;
      this.o.emit('voice:state', {
        voiceSessionId: this.voiceSessionId,
        state,
        ...(warning !== undefined ? { warning } : {}),
      });
      if (entering) this.syncIdle(state, true);
    }
  }

  /** Une session d'écoute ouverte quand le micro compte, aucune sinon. */
  private syncListening(): void {
    const open = this.micOpen();
    const id = this.listenId;
    if (open && id === undefined) {
      this.startListening();
      return;
    }
    // Un texte final en cours n'est pas jeté : la phrase a été dite avant la voix.
    if (!open && id !== undefined && !this.listenStopping) {
      this.listenId = undefined;
      this.listenStarting = false;
      this.warning = undefined;
      this.o.listener.cancel(id);
    }
  }

  private startListening(): void {
    this.listenCount += 1;
    const id = `${this.voiceSessionId}#${String(this.listenCount)}`;
    this.listenId = id;
    this.listenStarting = true;
    this.o.listener
      .start(id, {
        maxDurationMs: CONVERSATION_LISTEN_MAX_MS,
        endOfTurnSilenceMs: this.endOfTurnSilenceMs,
      })
      .then(
        () => {
          if (this.listenId === id) this.listenStarting = false;
        },
        (error: unknown) => {
          if (this.listenId !== id) return;
          this.listenId = undefined;
          this.listenStarting = false;
          this.log('écoute impossible', { code: codeOf(error) });
          this.finish('error');
        },
      );
  }

  private listenClosed(listenId: string): void {
    if (this.listenId !== listenId) return;
    this.listenId = undefined;
    this.listenStarting = false;
    this.listenStopping = false;
    this.warning = undefined;
  }

  private startGuard(): void {
    this.clearTimer(this.guardTimer);
    this.guardTimer = this.timers.setTimeout(() => {
      this.guardTimer = undefined;
      this.refresh();
    }, this.echoGuardMs);
  }

  /** La minuterie d'inactivité ne court que pendant l'écoute, sans tour ni voix. */
  private syncIdle(state: VoiceSessionState, restart: boolean): void {
    const listening = state === 'listening' || state === 'starting';
    if (!listening) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = undefined;
      return;
    }
    if (!restart && this.idleTimer !== undefined) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      this.finish('idle');
    }, this.idleMs);
  }

  /** De la parole a été entendue : 60 s de nouveau, si l'on écoute. */
  private rearmIdle(): void {
    if (this.idleTimer !== undefined) this.syncIdle(this.deriveState(), true);
  }

  private finish(reason: ConversationEndReason): void {
    if (this.ended) return;
    this.ended = true;
    const id = this.listenId;
    this.listenId = undefined;
    if (id !== undefined) this.o.listener.cancel(id);
    this.speech.interrupt();
    this.utterances = [];
    this.queue = [];
    this.clearPlayback();
    this.clearTimer(this.guardTimer);
    this.guardTimer = undefined;
    this.clearTimer(this.idleTimer);
    this.idleTimer = undefined;
    this.o.emit('voice:state', { voiceSessionId: this.voiceSessionId, state: 'idle' });
    this.log('mode conversation terminé', { reason });
    if (reason !== 'stopped') this.o.onEnd?.(reason);
  }

  private clearTimer(handle: unknown): void {
    if (handle !== undefined) this.timers.clearTimeout(handle);
  }

  private log(message: string, data?: Record<string, unknown>): void {
    this.o.log?.(`voice: ${message}`, data);
  }
}

function codeOf(error: unknown): string {
  return error instanceof AtelierError ? error.code : 'internal';
}
