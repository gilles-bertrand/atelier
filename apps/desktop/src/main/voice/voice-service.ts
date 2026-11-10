/**
 * `VoiceService` (ADR-004 D2, D3, D5, D6, L3) : la voix côté main.
 *
 * - Modèles : `VoiceModelManager` (L1) ; progression diffusée par `voice:model`.
 * - Moteur : `VoiceWorkerSupervisor` (L2) et son `utilityProcess`, lancé à la
 *   demande, arrêté après `idleUnloadMinutes` d'inactivité.
 * - Sessions : une seule à la fois (`voice/busy`), rattachée à la fenêtre qui
 *   l'a ouverte. Les trames du micro (`voice:audio`) ne sont relayées que pour
 *   la session active, depuis le cadre principal de cette fenêtre ; `seq`
 *   révèle une perte ou un désordre.
 *
 * Mode conversation (phase 2, L9) : `voice:start { mode: 'conversation' }`
 * exige une conversation et les modèles de reconnaissance et de synthèse ;
 * la session est confiée à un {@link VoiceConversation}, qui reçoit les
 * trames, les événements du worker et ceux de l'agent.
 *
 * Electron n'est pas importé ici : le worker, l'accès au micro et les
 * dialogues sont injectés (voir `electron-voice.ts`), d'où des tests sous Node.
 * Confidentialité (D9) : aucun audio ni transcript dans les journaux.
 */
import { randomUUID } from 'node:crypto';
import {
  AtelierError,
  DEFAULT_TTS_VOICE,
  VOICE_SAMPLE_RATE,
  type AgentEvent,
  type IpcEventChannel,
  type IpcEventPayload,
  type MicAccess,
  type PermissionRequest,
  type VoiceMode,
  type VoiceModelInfo,
  type VoiceSettings,
  type VoiceStatus,
} from '@atelier/shared';
import {
  AgentSpeech,
  SILERO_VAD,
  VoiceWorkerSupervisor,
  findTtsVoice,
  type EngineLoadConfigInput,
  type TtsLoadConfigInput,
  type VoiceModelManager,
  type WorkerHandle,
} from '@atelier/voice';
import {
  VoiceConversation,
  type ConversationAgent,
  type ConversationTimers,
} from './conversation.js';

/** Accès macOS au micro (`systemPreferences`), injecté. */
export interface MicrophoneAccess {
  status(): MicAccess;
  /** Demande l'accès (boîte de dialogue de macOS) ; seulement sur une action de l'utilisateur. */
  request(): Promise<MicAccess>;
  /** Ouvre Réglages Système › Confidentialité et sécurité › Micro. */
  openSettings(): Promise<void>;
}

/** Appelant d'un canal `invoke` (voir `ipc.ts`). */
export interface VoiceCaller {
  /** Identifiant du `webContents` émetteur. */
  senderId: number;
  /** Cadre principal d'une fenêtre de l'app (pas un sous-cadre : artefact, aperçu). */
  fromMainFrame: boolean;
}

export interface VoiceServiceOptions {
  models: Pick<
    VoiceModelManager,
    'status' | 'install' | 'importArchive' | 'cancel' | 'remove' | 'resolve'
  >;
  /** Lance le process de reconnaissance (`utilityProcess.fork`). */
  spawnWorker: () => WorkerHandle;
  settings: () => VoiceSettings;
  mic: MicrophoneAccess;
  /** Sélecteur de fichier pour l'import hors ligne ; `null` si annulé. */
  chooseArchive: () => Promise<string | null>;
  emit: <C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>) => void;
  newId?: () => string;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Délais du superviseur (tests). */
  supervisor?: { loadTimeoutMs?: number; stopTimeoutMs?: number; exitGraceMs?: number };
  /**
   * Agent des conversations (mode conversation, L9) ; absent : `voice:start`
   * en mode `conversation` est refusé.
   */
  agent?: ConversationAgent & { has(sessionId: string): boolean };
  /** Minuterie du mode conversation (tests). */
  timers?: ConversationTimers;
}

interface ActiveSession {
  id: string;
  mode: VoiceMode;
  /** Mode conversation : l'orchestrateur, une fois les modèles chargés. */
  conversation?: VoiceConversation;
  senderId: number;
  /** Prochain `seq` attendu. */
  nextSeq: number;
  lostFrames: number;
  reorderedFrames: number;
}

/** Bilan des trames d'une session (journal, sans contenu). */
export interface VoiceSessionStats {
  lostFrames: number;
  reorderedFrames: number;
}

function micDenied(access: MicAccess): AtelierError {
  return new AtelierError(
    'voice/mic_denied',
    access === 'not-determined'
      ? 'Autorisez l’accès au micro pour dicter.'
      : 'L’accès au micro est refusé dans les Réglages Système.',
    { details: { access } },
  );
}

/** Service vocal du main : un par app. */
export class VoiceService {
  private readonly options: VoiceServiceOptions;
  private readonly supervisor: VoiceWorkerSupervisor;
  private readonly newId: () => string;
  private session: ActiveSession | undefined;
  /** Modèles à charger, résolus avant chaque lancement du worker. */
  private loadConfig: EngineLoadConfigInput | undefined;
  /** Voix de synthèse à charger (mode conversation), résolue au démarrage. */
  private ttsConfig: (TtsLoadConfigInput & { modelId: string }) | undefined;
  private lastStats: VoiceSessionStats | undefined;

  constructor(options: VoiceServiceOptions) {
    this.options = options;
    this.newId = options.newId ?? randomUUID;
    this.supervisor = new VoiceWorkerSupervisor({
      spawn: options.spawnWorker,
      loadConfig: () => {
        if (this.loadConfig === undefined) {
          throw new AtelierError('voice/model_missing', 'Modèle de reconnaissance non installé.');
        }
        return this.loadConfig;
      },
      ttsLoadConfig: () => {
        const config = this.ttsConfig;
        if (config === undefined) {
          throw new AtelierError('voice/model_missing', 'Voix de synthèse non installée.');
        }
        return { voice: config.voice, dir: config.dir };
      },
      idleUnloadMinutes: options.settings().idleUnloadMinutes,
      ...options.supervisor,
      onEngineState: () => {
        void this.emitStatus();
      },
      onTranscript: (segment) => {
        const conversation = this.conversationOf(segment.voiceSessionId);
        if (conversation) conversation.transcript(segment);
        else options.emit('voice:transcript', segment);
      },
      onSessionState: (voiceSessionId, state, warning) => {
        const conversation = this.conversationOf(voiceSessionId);
        if (conversation) {
          // Les états de l'écoute restent internes : l'orchestrateur publie les siens.
          conversation.listenState(voiceSessionId, warning);
          return;
        }
        options.emit('voice:state', {
          voiceSessionId,
          state,
          ...(warning !== undefined ? { warning } : {}),
        });
      },
      onAutoStop: (voiceSessionId, text) => {
        const conversation = this.conversationOf(voiceSessionId);
        if (conversation) {
          conversation.listenAutoStopped(voiceSessionId, text);
          return;
        }
        this.endSession(voiceSessionId);
        options.emit('voice:state', { voiceSessionId, state: 'idle' });
      },
      onSessionError: (voiceSessionId, error) => {
        this.log('session vocale en échec', { code: error.code });
        const conversation = this.conversationOf(voiceSessionId);
        if (conversation) {
          conversation.listenFailed(voiceSessionId, error);
          return;
        }
        this.endSession(voiceSessionId);
        options.emit('voice:state', { voiceSessionId, state: 'idle' });
      },
      onTurnEnd: (voiceSessionId) => {
        this.conversationOf(voiceSessionId)?.turnEnded(voiceSessionId);
      },
      onSpeechStart: (voiceSessionId) => {
        this.conversationOf(voiceSessionId)?.speechStarted(voiceSessionId);
      },
    });
  }

  /** Session en cours, s'il y en a une. */
  get activeSessionId(): string | undefined {
    return this.session?.id;
  }

  /** Bilan des trames de la dernière session terminée. */
  get lastSessionStats(): VoiceSessionStats | undefined {
    return this.lastStats;
  }

  // ------------------------------------------------------------- état, modèles

  async status(): Promise<VoiceStatus> {
    return {
      mic: this.options.mic.status(),
      engine: this.supervisor.engineState,
      models: await this.models(),
    };
  }

  /** Relais de `VoiceModelManager.onModelChange` : `voice:model` puis `voice:status`. */
  modelChanged(info: VoiceModelInfo): void {
    this.options.emit('voice:model', this.withLoaded(info));
    if (info.state !== 'downloading') void this.emitStatus();
  }

  requestMic(): Promise<MicAccess> {
    return this.options.mic.request();
  }

  openMicSettings(): Promise<void> {
    return this.options.mic.openSettings();
  }

  async installModel(id: string): Promise<void> {
    const sourceUrl = this.options.settings().modelSourceUrl;
    await this.options.models.install(id, sourceUrl !== undefined ? { sourceUrl } : {});
  }

  cancelInstall(id: string): void {
    this.options.models.cancel(id);
  }

  async removeModel(id: string): Promise<void> {
    // Le modèle chargé ne peut pas disparaître sous le moteur.
    if (id === this.loadConfig?.stt.modelId || id === this.ttsConfig?.modelId) {
      if (this.session) {
        throw new AtelierError('voice/busy', 'Terminez la dictée avant de supprimer le modèle.');
      }
      this.supervisor.shutdown();
      this.loadConfig = undefined;
      this.ttsConfig = undefined;
    }
    await this.options.models.remove(id);
  }

  async importModel(id: string): Promise<void> {
    const archive = await this.options.chooseArchive();
    if (archive === null) return;
    await this.options.models.importArchive(id, archive);
  }

  // ------------------------------------------------------------------ sessions

  /**
   * Ouvre une session : dictée (micro autorisé, modèle de reconnaissance
   * installé) ou conversation (`sessionId` requis, reconnaissance et synthèse
   * installées ; sinon `voice/model_missing` avec `details.id`).
   */
  async start(
    caller: VoiceCaller,
    request: { mode?: VoiceMode; sessionId?: string } = {},
  ): Promise<{ voiceSessionId: string }> {
    this.assertMainFrame(caller);
    const mode = request.mode ?? 'dictation';
    if (this.session) throw new AtelierError('voice/busy', 'Une session vocale est déjà en cours.');
    const sessionId = mode === 'conversation' ? this.assertConversation(request.sessionId) : '';
    const access = this.options.mic.status();
    if (access !== 'granted') throw micDenied(access);

    const id = this.newId();
    // Réservée tout de suite : deux clics rapides ne lancent pas deux sessions.
    const session: ActiveSession = {
      id,
      mode,
      senderId: caller.senderId,
      nextSeq: 0,
      lostFrames: 0,
      reorderedFrames: 0,
    };
    this.session = session;
    try {
      await this.prepareModels(mode === 'conversation');
      if (mode === 'conversation') {
        await this.supervisor.ensureLoaded();
        await this.supervisor.ensureSpeechLoaded();
      } else {
        await this.supervisor.start(id);
      }
    } catch (error) {
      if (this.session === session) this.session = undefined;
      throw error;
    }
    // Annulée pendant le chargement (fenêtre fermée, veille) : rien ne démarre.
    if (this.session !== session) {
      throw new AtelierError('voice/engine_failed', 'La session vocale a été interrompue.');
    }
    if (mode === 'conversation') {
      session.conversation = this.createConversation(id, sessionId);
      session.conversation.begin();
    }
    return { voiceSessionId: id };
  }

  /** Termine la session et rend le texte final (rien en mode conversation : les tours sont déjà partis). */
  async stop(caller: VoiceCaller, voiceSessionId: string): Promise<{ text: string }> {
    this.assertOwner(caller, voiceSessionId);
    const conversation = this.session?.conversation;
    if (conversation) {
      conversation.end();
      this.endSession(voiceSessionId);
      return { text: '' };
    }
    try {
      const text = await this.supervisor.stop(voiceSessionId);
      return { text };
    } finally {
      this.endSession(voiceSessionId);
    }
  }

  /** Abandonne la session : rien n'est rendu. */
  cancel(caller: VoiceCaller, voiceSessionId: string): void {
    if (this.session?.id !== voiceSessionId) return;
    this.assertOwner(caller, voiceSessionId);
    this.abandon();
  }

  /**
   * Mode conversation, bouton « Interrompre » ou raccourci : voix coupée et
   * tour arrêté. Sans effet hors d'une conversation en cours.
   */
  interrupt(caller: VoiceCaller, voiceSessionId: string): void {
    if (this.session?.id !== voiceSessionId) return;
    this.assertOwner(caller, voiceSessionId);
    this.session.conversation?.interrupt();
  }

  /** Mode conversation : le renderer a fini de jouer la voix du tour `turnId`. */
  playbackEnded(
    caller: VoiceCaller,
    voiceSessionId: string,
    turnId: string,
    lastSeq: number,
  ): void {
    // Message en vol après la fin de la session : ignoré.
    if (this.session?.id !== voiceSessionId) return;
    this.assertOwner(caller, voiceSessionId);
    if (!Number.isInteger(lastSeq) || lastSeq < 0) {
      throw new AtelierError('internal', 'Numéro de morceau invalide.');
    }
    this.session.conversation?.playbackEnded(turnId, lastSeq);
  }

  /** Événement de l'agent (relais du `ChatManager`) : la conversation vocale en suit le tour. */
  agentEvent(event: AgentEvent): void {
    this.session?.conversation?.agentEvent(event);
  }

  /** Demande de permission close (`PermissionBroker.onSettled`). */
  permissionSettled(request: PermissionRequest): void {
    this.session?.conversation?.permissionSettled(request);
  }

  /**
   * Trame du micro. Refusée (exception) si elle vient d'un sous-cadre ou d'une
   * autre fenêtre que celle de la session ; ignorée hors d'une session active
   * (trames en vol après `stop`). Une trame en retard ou en double est écartée.
   */
  audio(caller: VoiceCaller, voiceSessionId: string, seq: number, pcm: unknown): void {
    this.assertMainFrame(caller);
    const session = this.session;
    if (session?.id !== voiceSessionId) return;
    if (caller.senderId !== session.senderId) {
      throw new AtelierError('voice/busy', 'La dictée a été ouverte dans une autre fenêtre.');
    }
    if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > VOICE_SAMPLE_RATE) {
      throw new AtelierError('internal', 'Trame audio invalide.');
    }
    if (!Number.isInteger(seq) || seq < 0)
      throw new AtelierError('internal', 'Numéro de trame invalide.');
    if (seq < session.nextSeq) {
      session.reorderedFrames += 1;
      return;
    }
    if (seq > session.nextSeq) session.lostFrames += seq - session.nextSeq;
    session.nextSeq = seq + 1;
    if (session.mode === 'conversation') {
      // Semi-duplex : l'orchestrateur décide si la trame va à la détection de parole.
      session.conversation?.audio(seq, pcm);
      return;
    }
    this.supervisor.audio(voiceSessionId, seq, pcm);
  }

  /** Fenêtre fermée ou rechargée : sa session est abandonnée. */
  senderGone(senderId: number): void {
    const session = this.session;
    if (session?.senderId !== senderId) return;
    this.abandon();
  }

  /** Mise en veille du Mac : la session est abandonnée (D7 : fin sur mise en veille). */
  suspend(): void {
    this.abandon();
  }

  /** Réglages modifiés : délai d'inactivité appliqué tout de suite. */
  settingsChanged(next: VoiceSettings, previous: VoiceSettings): void {
    if (next.idleUnloadMinutes !== previous.idleUnloadMinutes) {
      this.supervisor.setIdleUnloadMinutes(next.idleUnloadMinutes);
    }
    // Voix désactivée ou modèle changé : le moteur chargé est libéré.
    if ((!next.enabled && previous.enabled) || next.sttModel !== previous.sttModel) {
      if (!this.session) {
        this.supervisor.shutdown();
        this.loadConfig = undefined;
      }
    }
  }

  /**
   * Préchargement au démarrage (D5) : voix active, modèle installé et au moins
   * 32 Go de mémoire. Silencieux en cas d'échec.
   */
  async preload(totalMemoryBytes: number): Promise<void> {
    const settings = this.options.settings();
    if (!settings.enabled || totalMemoryBytes < 32 * 1024 ** 3) return;
    try {
      await this.prepareModels();
      await this.supervisor.ensureLoaded();
    } catch (error) {
      this.log('préchargement de la voix impossible', {
        code: error instanceof AtelierError ? error.code : 'internal',
      });
    }
  }

  /** Fermeture de l'app. */
  shutdown(): void {
    this.session?.conversation?.end();
    this.session = undefined;
    this.supervisor.shutdown();
  }

  // ------------------------------------------------------------------ interne

  /** Abandonne la session en cours (Échap, fenêtre, veille) et publie `idle`. */
  private abandon(): void {
    const session = this.session;
    if (!session) return;
    if (session.conversation) {
      session.conversation.end();
    } else {
      this.supervisor.cancel(session.id);
      this.options.emit('voice:state', { voiceSessionId: session.id, state: 'idle' });
    }
    this.endSession(session.id);
  }

  /** Conversation de l'app à laquelle parler ; refusée si absente ou inconnue. */
  private assertConversation(sessionId: string | undefined): string {
    const agent = this.options.agent;
    if (agent === undefined) {
      throw new AtelierError('voice/engine_failed', 'Le mode conversation n’est pas disponible.');
    }
    if (sessionId === undefined || sessionId === '' || !agent.has(sessionId)) {
      throw new AtelierError(
        'session/not_found',
        'Ouvrez une conversation pour parler à l’agent.',
        {
          details: { sessionId: sessionId ?? null },
        },
      );
    }
    return sessionId;
  }

  private createConversation(voiceSessionId: string, sessionId: string): VoiceConversation {
    const settings = this.options.settings();
    const agent = this.options.agent;
    if (agent === undefined) throw new AtelierError('internal', 'Agent absent.');
    return new VoiceConversation({
      voiceSessionId,
      sessionId,
      ...(settings.endOfTurnSilenceMs !== undefined
        ? { endOfTurnSilenceMs: settings.endOfTurnSilenceMs }
        : {}),
      listener: {
        start: (listenId, options) => this.supervisor.start(listenId, options),
        stop: (listenId) => this.supervisor.stop(listenId),
        cancel: (listenId) => {
          this.supervisor.cancel(listenId);
        },
        audio: (listenId, seq, pcm) => {
          this.supervisor.audio(listenId, seq, pcm);
        },
      },
      createSpeech: (sink) =>
        new AgentSpeech({
          voiceSessionId,
          synthesizer: this.supervisor,
          onAudio: sink.onAudio,
          onError: sink.onError,
          ...(settings.ttsRate !== undefined ? { rate: settings.ttsRate } : {}),
        }),
      agent,
      emit: this.options.emit,
      onEnd: () => {
        this.endSession(voiceSessionId);
      },
      ...(this.options.timers ? { timers: this.options.timers } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
    });
  }

  /** Orchestrateur auquel appartient une session d'écoute du worker. */
  private conversationOf(listenId: string): VoiceConversation | undefined {
    const conversation = this.session?.conversation;
    return conversation?.owns(listenId) === true ? conversation : undefined;
  }

  private async prepareModels(withSpeech = false): Promise<void> {
    const settings = this.options.settings();
    const voiceId = settings.ttsVoice ?? DEFAULT_TTS_VOICE;
    const ttsVoice = withSpeech ? findTtsVoice(voiceId) : undefined;
    if (withSpeech && ttsVoice === undefined) {
      throw new AtelierError('voice/model_invalid', 'Voix de synthèse inconnue.', {
        details: { id: voiceId },
      });
    }
    const [vad, stt, tts] = await Promise.all([
      this.options.models.resolve(SILERO_VAD.id),
      this.options.models.resolve(settings.sttModel),
      ttsVoice !== undefined ? this.options.models.resolve(ttsVoice.modelId) : undefined,
    ]);
    const vadFile = Object.values(vad.files)[0];
    if (vadFile === undefined) {
      throw new AtelierError('voice/model_missing', 'Détection de parole absente de l’app.');
    }
    const next: EngineLoadConfigInput = {
      vadModel: vadFile,
      stt: { modelId: stt.id, dir: stt.dir },
    };
    const previous = this.loadConfig;
    if (
      previous !== undefined &&
      (previous.vadModel !== next.vadModel || previous.stt.dir !== next.stt.dir)
    ) {
      // Autre modèle (mise à jour, réglage) : le prochain chargement repart d'un worker neuf.
      this.supervisor.shutdown();
    }
    this.loadConfig = next;
    if (ttsVoice !== undefined && tts !== undefined) {
      const previousTts = this.ttsConfig;
      if (
        previousTts !== undefined &&
        (previousTts.voice !== ttsVoice.id || previousTts.dir !== tts.dir)
      ) {
        // Autre voix : le worker la recharge à neuf.
        this.supervisor.shutdown();
      }
      this.ttsConfig = { voice: ttsVoice.id, dir: tts.dir, modelId: tts.id };
    }
  }

  private assertMainFrame(caller: VoiceCaller): void {
    if (!caller.fromMainFrame) {
      throw new AtelierError(
        'voice/mic_denied',
        'La voix n’est accessible qu’à la fenêtre de l’app.',
      );
    }
  }

  private assertOwner(caller: VoiceCaller, voiceSessionId: string): void {
    this.assertMainFrame(caller);
    const session = this.session;
    if (session?.id !== voiceSessionId) {
      throw new AtelierError('voice/engine_failed', 'Aucune dictée en cours.');
    }
    if (session.senderId !== caller.senderId) {
      throw new AtelierError('voice/busy', 'La dictée a été ouverte dans une autre fenêtre.');
    }
  }

  private endSession(voiceSessionId: string): void {
    const session = this.session;
    if (session?.id !== voiceSessionId) return;
    this.lastStats = { lostFrames: session.lostFrames, reorderedFrames: session.reorderedFrames };
    if (session.lostFrames > 0 || session.reorderedFrames > 0) {
      this.log('trames du micro perdues ou en désordre', { ...this.lastStats });
    }
    this.session = undefined;
  }

  private async models(): Promise<VoiceModelInfo[]> {
    return (await this.options.models.status()).map((info) => this.withLoaded(info));
  }

  /** `installed` devient `loaded` pour les modèles chargés par le moteur. */
  private withLoaded(info: VoiceModelInfo): VoiceModelInfo {
    if (info.state !== 'installed' || this.supervisor.engineState !== 'ready') return info;
    const config = this.loadConfig;
    const loaded =
      info.id === config?.stt.modelId ||
      (info.id === SILERO_VAD.id && config !== undefined) ||
      (info.id === this.ttsConfig?.modelId && this.supervisor.speechReady);
    return loaded ? { ...info, state: 'loaded' } : info;
  }

  private async emitStatus(): Promise<void> {
    try {
      this.options.emit('voice:status', await this.status());
    } catch (error) {
      this.log('état de la voix illisible', {
        code: error instanceof AtelierError ? error.code : 'internal',
      });
    }
  }

  private log(message: string, data?: Record<string, unknown>): void {
    this.options.log?.(`voice: ${message}`, data);
  }
}
