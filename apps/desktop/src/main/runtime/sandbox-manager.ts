/**
 * Cycle de vie de la VM côté app : démarrage en arrière-plan, progression et
 * état relayés au renderer, montage du dossier de la session avant chaque
 * tour, réseau par session, réinitialisation.
 */
import {
  serializeError,
  type Sandbox,
  type SandboxDiagnostics,
  type SandboxProgress,
  type SandboxStatus,
} from '@atelier/shared';

export interface SandboxManagerOptions {
  /** Crée la VM (ressources et dossier des skills courants) ; `undefined` si impossible. */
  create: () => Sandbox;
  /** Vérifie que le moteur de VM est livré (sinon message clair, pas de crash). */
  preflight?: () => Promise<string | undefined>;
  onStatus: (status: SandboxStatus) => void;
  onProgress: (progress: SandboxProgress) => void;
  /** Réseau par défaut d'une session (Réglages). */
  defaultNetwork: () => boolean;
  log?: (message: string, error?: unknown) => void;
}

/** Intervalle de relevé de l'état pendant une opération longue. */
const STATUS_POLL_MS = 500;

export class SandboxManager {
  readonly #o: SandboxManagerOptions;
  #sandbox: Sandbox | undefined;
  #last: SandboxStatus = { state: 'absent', networkEnabled: false };
  #preflightError: string | undefined;
  #ready: Promise<void> | undefined;
  readonly #sessionNetwork = new Map<string, boolean>();

  constructor(options: SandboxManagerOptions) {
    this.#o = options;
  }

  status(): SandboxStatus {
    if (this.#preflightError) {
      return { state: 'error', networkEnabled: false, error: this.#preflightError };
    }
    return this.#sandbox?.status() ?? this.#last;
  }

  /** Démarre (ou crée et provisionne) la VM ; idempotent, ne rejette que via l'état. */
  ensureReady(): Promise<void> {
    this.#ready ??= this.#track(async () => {
      const problem = await this.#o.preflight?.();
      if (problem) {
        this.#preflightError = problem;
        this.#publish();
        throw new Error(problem);
      }
      this.#preflightError = undefined;
      await this.#instance().ensureReady((progress) => {
        this.#o.onProgress(progress);
        this.#publish();
      });
    }).finally(() => {
      this.#ready = undefined;
    });
    return this.#ready;
  }

  /** Démarrage au lancement : les erreurs restent dans l'état (pas d'exception). */
  startInBackground(): void {
    this.ensureReady().catch((error: unknown) => {
      this.#o.log?.('Démarrage de la VM impossible', error);
    });
  }

  /**
   * VM prête à servir un tour de `sessionId` dans `workspace` : monte le dossier
   * (redémarrage si besoin) et applique le réseau de la session. Renvoie
   * `undefined` si la VM n'est pas prête : l'outil `bash` répond alors « VM
   * indisponible » au modèle au lieu de bloquer le tour.
   */
  async prepareForTurn(sessionId: string, workspace: string): Promise<Sandbox | undefined> {
    const sandbox = this.#sandbox;
    if (!sandbox || sandbox.status().state !== 'ready') {
      // Le dossier sera monté au prochain démarrage.
      if (sandbox) await sandbox.setWorkspace(workspace).catch(() => undefined);
      return undefined;
    }
    try {
      await this.#track(() => sandbox.setWorkspace(workspace));
      const wanted = this.networkFor(sessionId);
      if (sandbox.status().networkEnabled !== wanted) await sandbox.setNetwork(wanted);
      this.#publish();
      return sandbox.status().state === 'ready' ? sandbox : undefined;
    } catch (error) {
      this.#o.log?.('Montage du dossier impossible', error);
      this.#publish();
      return undefined;
    }
  }

  /** Réseau voulu pour une session. */
  networkFor(sessionId: string): boolean {
    return this.#sessionNetwork.get(sessionId) ?? this.#o.defaultNetwork();
  }

  /** Autorise ou coupe le réseau pour une session (appliqué tout de suite à la VM). */
  async setNetwork(sessionId: string, enabled: boolean): Promise<void> {
    this.#sessionNetwork.set(sessionId, enabled);
    const sandbox = this.#sandbox;
    if (sandbox?.status().state === 'ready') await sandbox.setNetwork(enabled);
    this.#publish();
  }

  async diagnostics(): Promise<SandboxDiagnostics> {
    return this.#instance().diagnostics();
  }

  /** Supprime et recrée la VM (avec les ressources courantes des Réglages). */
  async reset(): Promise<void> {
    const old = this.#sandbox;
    if (old) await old.stop().catch(() => undefined);
    // Nouvelle instance : CPU, mémoire et dossier des skills relus dans les Réglages.
    this.#sandbox = this.#o.create();
    const fresh = this.#sandbox;
    await this.#track(() =>
      fresh.reset((progress) => {
        this.#o.onProgress(progress);
        this.#publish();
      }),
    );
  }

  async stop(): Promise<void> {
    await this.#sandbox?.stop();
    this.#publish();
  }

  /** Accès direct (outils) : la VM si elle est prête. */
  current(): Sandbox | undefined {
    return this.#sandbox?.status().state === 'ready' ? this.#sandbox : undefined;
  }

  #instance(): Sandbox {
    this.#sandbox ??= this.#o.create();
    return this.#sandbox;
  }

  /** Exécute une opération en relayant l'état pendant qu'elle dure. */
  async #track<T>(operation: () => Promise<T>): Promise<T> {
    this.#publish();
    const timer = setInterval(() => {
      this.#publish();
    }, STATUS_POLL_MS);
    try {
      return await operation();
    } catch (error) {
      this.#o.log?.('Opération VM en échec', serializeError(error));
      throw error;
    } finally {
      clearInterval(timer);
      this.#publish();
    }
  }

  #publish(): void {
    const next = this.status();
    const prev = this.#last;
    this.#last = next;
    if (
      next.state !== prev.state ||
      next.workspace !== prev.workspace ||
      next.networkEnabled !== prev.networkEnabled ||
      next.error !== prev.error
    ) {
      this.#o.onStatus(next);
    }
  }
}
