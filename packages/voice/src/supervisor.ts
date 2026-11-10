/**
 * Côté main du protocole (ADR-004 D2, D5) : lance le worker de reconnaissance
 * à la demande, le décharge après `idleUnloadMinutes` d'inactivité et le
 * relance après un crash.
 *
 * Le `VoiceService` du main (L3) l'utilise avec `utilityProcess.fork` ; les
 * tests, avec un faux worker. Aucune dépendance à Electron.
 *
 * Phase 2 (L7) : la synthèse se charge à la demande dans le même worker
 * ({@link VoiceWorkerSupervisor.ensureSpeechLoaded}) et le superviseur sert de
 * {@link SpeechSynthesisPort} à `AgentSpeech`. Elle suppose le worker lancé,
 * donc la reconnaissance chargée : le mode conversation a besoin des deux.
 */
import {
  AtelierError,
  DEFAULT_VOICE_SETTINGS,
  type VoiceEngineState,
  type VoiceInputWarning,
  type VoiceSessionState,
  type TranscriptSegment,
} from '@atelier/shared';
import {
  parseWorkerToMain,
  type EngineLoadConfigInput,
  type MainToWorkerMessage,
  type TtsLoadConfigInput,
  type WorkerToMainMessage,
} from './protocol.js';
import type { SpeechSynthesisPort, SynthesizedSpeech } from './speech.js';

/** Process du worker, vu du main (`UtilityProcess` d'Electron, adapté). */
export interface WorkerHandle {
  postMessage(message: MainToWorkerMessage): void;
  onMessage(listener: (data: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

/** Événements d'une session, à diffuser au renderer (`voice:transcript`, `voice:state`). */
export interface SupervisorEvents {
  onEngineState?: (state: VoiceEngineState) => void;
  onTranscript?: (segment: TranscriptSegment) => void;
  onSessionState?: (
    voiceSessionId: string,
    state: VoiceSessionState,
    warning?: VoiceInputWarning,
  ) => void;
  /** Arrêt automatique à la durée maximale : texte final. */
  onAutoStop?: (voiceSessionId: string, text: string) => void;
  /** Échec pendant une session (moteur, crash du worker). */
  onSessionError?: (voiceSessionId: string, error: AtelierError) => void;
}

export interface SupervisorOptions extends SupervisorEvents {
  /** Lance un worker neuf. */
  spawn: () => WorkerHandle;
  /** Modèles à charger, lus au moment du chargement (réglages et modèles installés). */
  loadConfig: () => EngineLoadConfigInput;
  /** Minutes d'inactivité avant l'arrêt du worker ; `0` le garde chargé. */
  idleUnloadMinutes?: number;
  /** Délai maximal de chargement des modèles (60 s par défaut). */
  loadTimeoutMs?: number;
  /** Délai maximal de la transcription finale après `stop` (60 s par défaut). */
  stopTimeoutMs?: number;
  /** Délai laissé au worker pour sortir après `shutdown`, avant `kill` (2 s par défaut). */
  exitGraceMs?: number;
  /**
   * Voix de synthèse à charger, lue au moment du chargement (réglage
   * `ttsVoice`, modèle installé). Absent : la synthèse n'est pas disponible.
   */
  ttsLoadConfig?: () => TtsLoadConfigInput;
  /** Délai maximal de synthèse d'un morceau (30 s par défaut). */
  speakTimeoutMs?: number;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: AtelierError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const engineFailed = (message: string): AtelierError =>
  new AtelierError('voice/engine_failed', message, { retryable: true });

/** Superviseur du worker : un seul worker, une seule session à la fois. */
export class VoiceWorkerSupervisor implements SpeechSynthesisPort {
  private readonly options: SupervisorOptions;
  private idleMinutes: number;
  private worker: WorkerHandle | undefined;
  private engine: VoiceEngineState = 'stopped';
  private loading: Pending<void> | undefined;
  private loaded: Promise<void> | undefined;
  private sessionId: string | undefined;
  private stopping: Pending<string> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Workers arrêtés volontairement : leur sortie n'est pas un crash. */
  private readonly retiring = new WeakSet<WorkerHandle>();
  /** Chargement de la voix de synthèse : fréquence de l'audio rendu. */
  private ttsLoading: Pending<number> | undefined;
  private ttsLoaded: Promise<number> | undefined;
  /** Morceaux en cours de synthèse, par numéro de requête. */
  private readonly speeches = new Map<number, Pending<SynthesizedSpeech>>();
  private nextRequestId = 0;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.idleMinutes = options.idleUnloadMinutes ?? DEFAULT_VOICE_SETTINGS.idleUnloadMinutes;
  }

  /** État du moteur (`voice:status`). */
  get engineState(): VoiceEngineState {
    return this.engine;
  }

  /** Session en cours, s'il y en a une. */
  get activeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Change le délai d'inactivité (Réglages › Voix) ; s'applique tout de suite. */
  setIdleUnloadMinutes(minutes: number): void {
    this.idleMinutes = minutes;
    if (this.worker !== undefined && this.sessionId === undefined) this.armIdle();
  }

  /** Lance le worker et charge les modèles, si ce n'est déjà fait. */
  ensureLoaded(): Promise<void> {
    this.disarmIdle();
    if (this.loaded !== undefined) return this.loaded;
    let config: EngineLoadConfigInput;
    try {
      // Modèle absent (`voice/model_missing`) : aucun worker n'est lancé.
      config = this.options.loadConfig();
    } catch (error) {
      return Promise.reject(
        error instanceof AtelierError
          ? error
          : engineFailed('Le modèle de reconnaissance est introuvable.'),
      );
    }
    const worker = this.spawnWorker();
    this.setEngine('loading');
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(worker, engineFailed('Le chargement du modèle de reconnaissance a expiré.'));
      }, this.options.loadTimeoutMs ?? 60_000);
      this.loading = { resolve, reject, timer };
    });
    this.loaded = promise;
    try {
      worker.postMessage({ type: 'load', config });
    } catch {
      this.fail(worker, engineFailed('Le moteur de reconnaissance n’a pas pu démarrer.'));
    }
    promise.then(
      () => {
        if (this.sessionId === undefined) this.armIdle();
      },
      () => undefined,
    );
    return promise;
  }

  /** Ouvre une session de dictée ; `voice/busy` si une autre est en cours. */
  async start(voiceSessionId: string, maxDurationMs?: number): Promise<void> {
    if (this.sessionId !== undefined) {
      throw new AtelierError('voice/busy', 'Une dictée est déjà en cours.');
    }
    this.sessionId = voiceSessionId;
    this.disarmIdle();
    try {
      await this.ensureLoaded();
    } catch (error) {
      this.sessionId = undefined;
      throw error;
    }
    if (this.sessionId !== voiceSessionId) {
      throw engineFailed('La dictée a été interrompue.');
    }
    this.post({
      type: 'start',
      voiceSessionId,
      ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    });
  }

  /** Relaie une trame du micro. Ignorée hors de la session en cours. */
  audio(voiceSessionId: string, seq: number, pcm: Float32Array): void {
    if (voiceSessionId !== this.sessionId || this.stopping !== undefined) return;
    this.post({ type: 'audio', voiceSessionId, seq, pcm });
  }

  /** Termine la session et rend le texte final. */
  stop(voiceSessionId: string): Promise<string> {
    if (voiceSessionId !== this.sessionId || this.worker === undefined) {
      return Promise.reject(engineFailed('Aucune dictée en cours.'));
    }
    if (this.stopping !== undefined) {
      return Promise.reject(new AtelierError('voice/busy', 'La dictée se termine déjà.'));
    }
    const worker = this.worker;
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(worker, engineFailed('La transcription a expiré.'));
      }, this.options.stopTimeoutMs ?? 60_000);
      this.stopping = { resolve, reject, timer };
    });
    this.post({ type: 'stop', voiceSessionId });
    return promise;
  }

  /** Abandonne la session : rien n'est rendu. */
  cancel(voiceSessionId: string): void {
    if (voiceSessionId !== this.sessionId) return;
    this.post({ type: 'cancel', voiceSessionId });
    this.settleStop(undefined, engineFailed('La dictée a été annulée.'));
    this.endSession();
  }

  /**
   * Charge la voix de synthèse dans le worker (en le lançant au besoin, avec la
   * reconnaissance), si ce n'est déjà fait. Rend la fréquence de l'audio.
   */
  async ensureSpeechLoaded(): Promise<number> {
    if (this.ttsLoaded !== undefined) return this.ttsLoaded;
    const read = this.options.ttsLoadConfig;
    if (read === undefined) {
      throw engineFailed('La synthèse vocale n’est pas disponible.');
    }
    // Modèle absent (`voice/model_missing`) : rien n'est envoyé au worker.
    const config = read();
    await this.ensureLoaded();
    return this.loadSpeech(config);
  }

  /** Envoie `tts-load` au worker lancé, sauf si un chargement est déjà en cours ou fait. */
  private loadSpeech(config: TtsLoadConfigInput): Promise<number> {
    if (this.ttsLoaded !== undefined) return this.ttsLoaded;
    const worker = this.worker;
    if (worker === undefined) return Promise.reject(engineFailed('Le moteur vocal s’est arrêté.'));
    const promise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(worker, engineFailed('Le chargement de la voix de synthèse a expiré.'));
      }, this.options.loadTimeoutMs ?? 60_000);
      this.ttsLoading = { resolve, reject, timer };
    });
    this.ttsLoaded = promise;
    // Un échec de chargement n'est pas définitif : le prochain appel réessaie.
    promise.catch(() => {
      if (this.ttsLoaded === promise) this.ttsLoaded = undefined;
    });
    this.post({ type: 'tts-load', config });
    return promise;
  }

  /**
   * Synthétise un morceau de texte déjà filtré ({@link SpeechSynthesisPort}).
   * Le texte n'apparaît dans aucun journal ni message d'erreur.
   */
  async synthesize(text: string, speed: number): Promise<SynthesizedSpeech> {
    await this.ensureSpeechLoaded();
    const worker = this.worker;
    if (worker === undefined) throw engineFailed('Le moteur vocal s’est arrêté.');
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.disarmIdle();
    const promise = new Promise<SynthesizedSpeech>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(worker, engineFailed('La synthèse vocale a expiré.'));
      }, this.options.speakTimeoutMs ?? 30_000);
      this.speeches.set(requestId, { resolve, reject, timer });
    });
    this.post({ type: 'speak', requestId, text, speed });
    return promise;
  }

  /** Arrête le worker (fermeture de l'app, voix désactivée). */
  shutdown(): void {
    const worker = this.worker;
    if (worker === undefined) return;
    if (this.sessionId !== undefined) this.cancel(this.sessionId);
    this.retire(worker);
  }

  private spawnWorker(): WorkerHandle {
    const worker = this.options.spawn();
    this.worker = worker;
    worker.onMessage((data) => {
      if (this.worker !== worker) return;
      const parsed = parseWorkerToMain(data);
      // Message invalide : ignoré, sans recopier son contenu dans les journaux.
      if (parsed.ok) this.handle(worker, parsed.message);
    });
    worker.onExit(() => {
      if (this.retiring.has(worker) || this.worker !== worker) return;
      this.fail(worker, engineFailed('Le moteur de reconnaissance s’est arrêté.'));
    });
    return worker;
  }

  private handle(worker: WorkerHandle, message: WorkerToMainMessage): void {
    switch (message.type) {
      case 'ready':
      case 'rejected':
        return;
      case 'loaded':
        if (this.loading !== undefined) {
          clearTimeout(this.loading.timer);
          this.loading.resolve();
          this.loading = undefined;
        }
        this.setEngine('ready');
        return;
      case 'state':
        if (message.voiceSessionId !== this.sessionId) return;
        this.options.onSessionState?.(message.voiceSessionId, message.state, message.warning);
        return;
      case 'transcript':
        if (message.segment.voiceSessionId !== this.sessionId) return;
        this.options.onTranscript?.(message.segment);
        return;
      case 'final':
        if (message.voiceSessionId !== this.sessionId) return;
        if (message.reason === 'max_duration' && this.stopping === undefined) {
          this.options.onAutoStop?.(message.voiceSessionId, message.text);
        }
        this.settleStop(message.text);
        this.endSession();
        return;
      case 'tts-loaded':
        if (this.ttsLoading !== undefined) {
          clearTimeout(this.ttsLoading.timer);
          this.ttsLoading.resolve(message.sampleRate);
          this.ttsLoading = undefined;
        }
        return;
      case 'speech':
        this.settleSpeech(message.requestId, {
          sampleRate: message.sampleRate,
          pcm: message.pcm,
        });
        return;
      case 'tts-error': {
        const error = new AtelierError(message.error.code, message.error.message, {
          retryable: message.error.retryable,
        });
        if (message.requestId !== undefined) {
          this.settleSpeech(message.requestId, undefined, error);
        } else if (this.ttsLoading !== undefined) {
          // La voix n'a pas pu charger : la reconnaissance, elle, reste utilisable.
          clearTimeout(this.ttsLoading.timer);
          this.ttsLoading.reject(error);
          this.ttsLoading = undefined;
        }
        return;
      }
      case 'error': {
        const error = new AtelierError(message.error.code, message.error.message, {
          retryable: message.error.retryable,
        });
        if (message.voiceSessionId === undefined) {
          // Échec du chargement : le worker est inutilisable.
          if (this.loading !== undefined) this.fail(worker, error);
          return;
        }
        if (message.voiceSessionId !== this.sessionId) return;
        this.options.onSessionError?.(message.voiceSessionId, error);
        this.settleStop(undefined, error);
        this.endSession();
        return;
      }
    }
  }

  /** Crash, délai dépassé ou échec du chargement : tout ce qui attend échoue, le worker est retiré. */
  private fail(worker: WorkerHandle, error: AtelierError): void {
    if (this.worker !== worker) return;
    if (this.loading !== undefined) {
      clearTimeout(this.loading.timer);
      this.loading.reject(error);
      this.loading = undefined;
    }
    const sessionId = this.sessionId;
    if (sessionId !== undefined) {
      this.options.onSessionError?.(sessionId, error);
      this.settleStop(undefined, error);
      this.sessionId = undefined;
    }
    this.rejectSpeech(error);
    this.retiring.add(worker);
    this.worker = undefined;
    this.loaded = undefined;
    this.disarmIdle();
    try {
      worker.kill();
    } catch {
      // Déjà sorti.
    }
    this.setEngine('error');
  }

  private settleStop(text: string | undefined, error?: AtelierError): void {
    const pending = this.stopping;
    if (pending === undefined) return;
    this.stopping = undefined;
    clearTimeout(pending.timer);
    if (text !== undefined) pending.resolve(text);
    else pending.reject(error ?? engineFailed('La dictée n’a pas abouti.'));
  }

  private endSession(): void {
    this.sessionId = undefined;
    this.armIdle();
  }

  private settleSpeech(
    requestId: number,
    speech: SynthesizedSpeech | undefined,
    error?: AtelierError,
  ): void {
    const pending = this.speeches.get(requestId);
    if (pending === undefined) return;
    this.speeches.delete(requestId);
    clearTimeout(pending.timer);
    if (speech !== undefined) pending.resolve(speech);
    else pending.reject(error ?? engineFailed('La synthèse vocale a échoué.'));
    if (this.speeches.size === 0 && this.sessionId === undefined) this.armIdle();
  }

  /** Worker perdu : la voix est à recharger et tout ce qui attend échoue. */
  private rejectSpeech(error: AtelierError): void {
    if (this.ttsLoading !== undefined) {
      clearTimeout(this.ttsLoading.timer);
      this.ttsLoading.reject(error);
      this.ttsLoading = undefined;
    }
    this.ttsLoaded = undefined;
    for (const pending of this.speeches.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.speeches.clear();
  }

  /** Arrêt volontaire : `shutdown`, puis `kill` si le worker ne sort pas à temps. */
  private retire(worker: WorkerHandle): void {
    this.retiring.add(worker);
    if (this.worker === worker) {
      this.worker = undefined;
      this.loaded = undefined;
      if (this.loading !== undefined) {
        clearTimeout(this.loading.timer);
        this.loading.reject(engineFailed('Le moteur de reconnaissance a été arrêté.'));
        this.loading = undefined;
      }
      this.rejectSpeech(engineFailed('Le moteur vocal a été arrêté.'));
    }
    this.disarmIdle();
    let exited = false;
    worker.onExit(() => {
      exited = true;
    });
    try {
      worker.postMessage({ type: 'shutdown' });
    } catch {
      exited = true;
    }
    const grace = setTimeout(() => {
      if (!exited) {
        try {
          worker.kill();
        } catch {
          // Déjà sorti.
        }
      }
    }, this.options.exitGraceMs ?? 2_000);
    grace.unref();
    this.setEngine('stopped');
  }

  private armIdle(): void {
    this.disarmIdle();
    if (this.idleMinutes <= 0 || this.worker === undefined) return;
    const worker = this.worker;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.worker === worker && this.sessionId === undefined && this.speeches.size === 0) {
        this.retire(worker);
      }
    }, this.idleMinutes * 60_000);
    this.idleTimer.unref();
  }

  private disarmIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private post(message: MainToWorkerMessage): void {
    const worker = this.worker;
    if (worker === undefined) return;
    try {
      worker.postMessage(message);
    } catch {
      this.fail(worker, engineFailed('Le moteur de reconnaissance ne répond plus.'));
    }
  }

  private setEngine(state: VoiceEngineState): void {
    if (this.engine === state) return;
    this.engine = state;
    this.options.onEngineState?.(state);
  }
}
