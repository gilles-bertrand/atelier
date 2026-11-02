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
 * Electron n'est pas importé ici : le worker, l'accès au micro et les
 * dialogues sont injectés (voir `electron-voice.ts`), d'où des tests sous Node.
 * Confidentialité (D9) : aucun audio ni transcript dans les journaux.
 */
import { randomUUID } from 'node:crypto';
import {
  AtelierError,
  VOICE_SAMPLE_RATE,
  type IpcEventChannel,
  type IpcEventPayload,
  type MicAccess,
  type VoiceModelInfo,
  type VoiceSettings,
  type VoiceStatus,
} from '@atelier/shared';
import {
  SILERO_VAD,
  VoiceWorkerSupervisor,
  type EngineLoadConfigInput,
  type VoiceModelManager,
  type WorkerHandle,
} from '@atelier/voice';

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
}

interface ActiveSession {
  id: string;
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
      idleUnloadMinutes: options.settings().idleUnloadMinutes,
      ...options.supervisor,
      onEngineState: () => {
        void this.emitStatus();
      },
      onTranscript: (segment) => {
        options.emit('voice:transcript', segment);
      },
      onSessionState: (voiceSessionId, state, warning) => {
        options.emit('voice:state', {
          voiceSessionId,
          state,
          ...(warning !== undefined ? { warning } : {}),
        });
      },
      onAutoStop: (voiceSessionId) => {
        this.endSession(voiceSessionId);
        options.emit('voice:state', { voiceSessionId, state: 'idle' });
      },
      onSessionError: (voiceSessionId, error) => {
        this.log('session vocale en échec', { code: error.code });
        this.endSession(voiceSessionId);
        options.emit('voice:state', { voiceSessionId, state: 'idle' });
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
    if (id === this.loadConfig?.stt.modelId) {
      if (this.session) {
        throw new AtelierError('voice/busy', 'Terminez la dictée avant de supprimer le modèle.');
      }
      this.supervisor.shutdown();
      this.loadConfig = undefined;
    }
    await this.options.models.remove(id);
  }

  async importModel(id: string): Promise<void> {
    const archive = await this.options.chooseArchive();
    if (archive === null) return;
    await this.options.models.importArchive(id, archive);
  }

  // ------------------------------------------------------------------ sessions

  /** Ouvre une session de dictée (micro autorisé, modèles installés). */
  async start(caller: VoiceCaller): Promise<{ voiceSessionId: string }> {
    this.assertMainFrame(caller);
    if (this.session) throw new AtelierError('voice/busy', 'Une dictée est déjà en cours.');
    const access = this.options.mic.status();
    if (access !== 'granted') throw micDenied(access);

    const id = this.newId();
    // Réservée tout de suite : deux clics rapides ne lancent pas deux sessions.
    this.session = { id, senderId: caller.senderId, nextSeq: 0, lostFrames: 0, reorderedFrames: 0 };
    try {
      await this.prepareModels();
      await this.supervisor.start(id);
    } catch (error) {
      if (this.session.id === id) this.session = undefined;
      throw error;
    }
    return { voiceSessionId: id };
  }

  /** Termine la session et rend le texte final. */
  async stop(caller: VoiceCaller, voiceSessionId: string): Promise<{ text: string }> {
    this.assertOwner(caller, voiceSessionId);
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
    this.supervisor.cancel(voiceSessionId);
    this.endSession(voiceSessionId);
    this.options.emit('voice:state', { voiceSessionId, state: 'idle' });
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
    this.supervisor.audio(voiceSessionId, seq, pcm);
  }

  /** Fenêtre fermée ou rechargée : sa session est abandonnée. */
  senderGone(senderId: number): void {
    const session = this.session;
    if (session?.senderId !== senderId) return;
    this.supervisor.cancel(session.id);
    this.endSession(session.id);
  }

  /** Mise en veille du Mac : la session est abandonnée (D7 : fin sur mise en veille). */
  suspend(): void {
    const session = this.session;
    if (!session) return;
    this.supervisor.cancel(session.id);
    this.endSession(session.id);
    this.options.emit('voice:state', { voiceSessionId: session.id, state: 'idle' });
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
    this.session = undefined;
    this.supervisor.shutdown();
  }

  // ------------------------------------------------------------------ interne

  private async prepareModels(): Promise<void> {
    const settings = this.options.settings();
    const [vad, stt] = await Promise.all([
      this.options.models.resolve(SILERO_VAD.id),
      this.options.models.resolve(settings.sttModel),
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
      info.id === config?.stt.modelId || (info.id === SILERO_VAD.id && config !== undefined);
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
