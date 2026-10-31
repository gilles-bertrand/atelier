/**
 * Interface de la VM d'exécution (implémentée par `packages/sandbox` avec Lima).
 *
 * La VM ne voit que le dossier de travail (`/workspace`, écriture), les dossiers
 * rattachés d'un projet (`/dossiers/<nom>`, ADR-003) et les skills (`/skills`,
 * lecture seule). Les commandes tournent sous l'utilisateur `agent`, dont le
 * réseau sortant est coupé par défaut.
 */

/** Chemin du dossier de travail dans la VM. */
export const GUEST_WORKSPACE = '/workspace';
/** Chemin du dossier des skills dans la VM (lecture seule). */
export const GUEST_SKILLS = '/skills';
/** Racine des dossiers rattachés d'un projet dans la VM (`/dossiers/<nom>`, ADR-003 D1). */
export const GUEST_FOLDERS = '/dossiers';

/** Dossier rattaché monté dans la VM en plus de `/workspace` (projet, ADR-003 D1). */
export interface SandboxFolderMount {
  /** Chemin absolu côté hôte. */
  host: string;
  /** Point de montage dans la VM, sous {@link GUEST_FOLDERS}. */
  guest: string;
  /** `false` : monté en lecture seule (dossier « lecture seule » du projet). */
  writable: boolean;
}

/** Étape de préparation de la VM, pour la barre de progression. */
export type SandboxPhase =
  | 'checking'
  | 'downloading_image'
  | 'creating'
  | 'starting'
  | 'provisioning'
  | 'configuring_mounts'
  | 'ready';

/** Progression émise par {@link Sandbox.ensureReady}. */
export interface SandboxProgress {
  /** Étape courante. */
  phase: SandboxPhase;
  /** Avancement global de 0 à 1, si connu. */
  progress?: number;
  /** Message lisible en français (« Téléchargement de l'image Ubuntu… »). */
  message: string;
}

/** État courant de la VM (indicateur du panneau latéral). */
export type SandboxState =
  'absent' | 'stopped' | 'starting' | 'provisioning' | 'ready' | 'restarting' | 'error';

/** Instantané d'état de la VM. */
export interface SandboxStatus {
  /** État courant. */
  state: SandboxState;
  /** Dossier de travail monté côté hôte, s'il y en a un. */
  workspace?: string;
  /** Dossiers rattachés montés sous `/dossiers` (projet), s'il y en a. */
  folders?: SandboxFolderMount[];
  /** Réseau sortant autorisé pour l'utilisateur `agent`. */
  networkEnabled: boolean;
  /** Message d'erreur lisible si `state === 'error'`. */
  error?: string;
  /**
   * Qui tient la VM en ce moment (une seule VM, montée sur un seul dossier :
   * les tours qui l'utilisent sont sérialisés par dossier, ADR-002 D5). Absent :
   * personne. Le Composer l'affiche et propose « Arrêter » pour un run planifié.
   */
  heldBy?: SandboxHolder;
}

/** Détenteur de la VM : un run planifié (`runId`, `taskName`) ou une conversation (`sessionId`). */
export interface SandboxHolder {
  /** Dossier monté pour ce détenteur. */
  workspace: string;
  /** Projet de ce détenteur : ses dossiers rattachés sont montés avec le principal. */
  projectName?: string;
  /** Présent : un run planifié tient la VM. */
  runId?: string;
  /** Nom de la tâche, présent avec `runId`. */
  taskName?: string;
  /** Présent : une conversation interactive tient la VM. */
  sessionId?: string;
}

/** Options d'exécution d'une commande. */
export interface SandboxExecOptions {
  /** Délai maximal en millisecondes (défaut : 120 000). La commande est tuée au-delà. */
  timeoutMs?: number;
  /** Répertoire de travail dans la VM (défaut : `/workspace`). */
  cwd?: string;
  /** Taille maximale de sortie renvoyée, en octets (défaut : 10 240). */
  maxOutputBytes?: number;
  /** Variables d'environnement supplémentaires. */
  env?: Record<string, string>;
  /** Signal d'annulation (bouton stop). */
  signal?: AbortSignal;
}

/** Résultat d'une commande exécutée dans la VM. */
export interface SandboxExecResult {
  /** Code de sortie (`null` si tuée). */
  exitCode: number | null;
  /** Sortie standard (tronquée). */
  stdout: string;
  /** Sortie d'erreur (tronquée). */
  stderr: string;
  /** Vrai si la sortie a été tronquée. */
  truncated: boolean;
  /** Vrai si la commande a dépassé le délai. */
  timedOut: boolean;
  /** Durée d'exécution en millisecondes. */
  durationMs: number;
}

/** Ressources de la VM (Réglages). */
export interface SandboxResources {
  /** Nombre de CPU (défaut 4). */
  cpus: number;
  /** Mémoire en Gio (défaut 4). */
  memoryGiB: number;
  /** Disque en Gio. */
  diskGiB?: number;
}

/** Diagnostic brut pour les Réglages (issu de `limactl list --json`). */
export interface SandboxDiagnostics {
  /** Version de limactl embarquée. */
  limaVersion?: string;
  /** `LIMA_HOME` utilisé. */
  limaHome: string;
  /** Statut tel que rapporté par Lima. */
  rawStatus?: string;
  /** Ressources configurées. */
  resources: SandboxResources;
  /** Informations libres supplémentaires. */
  extra?: Record<string, unknown>;
}

/**
 * VM d'exécution isolée.
 *
 * Toutes les méthodes rejettent avec une `AtelierError` (`sandbox/*`) en cas
 * d'échec ; `exec` ne rejette PAS pour un code de sortie non nul.
 */
export interface Sandbox {
  /**
   * Crée, provisionne ou démarre la VM si nécessaire ; idempotent.
   * @param onProgress - Rappel de progression pour l'UI.
   */
  ensureReady(onProgress?: (progress: SandboxProgress) => void): Promise<void>;

  /**
   * Change le dossier monté sur `/workspace` et les dossiers rattachés montés
   * sous `/dossiers` (redémarre la VM si les montages changent ; objectif < 15 s).
   * @param hostDir - Chemin absolu côté hôte.
   * @param folders - Dossiers rattachés d'un projet ; absent ou vide : aucun.
   */
  setWorkspace(hostDir: string, folders?: readonly SandboxFolderMount[]): Promise<void>;

  /**
   * Exécute une commande shell (`bash -lc`) en tant qu'utilisateur `agent`.
   * @param command - Ligne de commande.
   * @param options - Délai, cwd, troncature, annulation.
   */
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;

  /** Autorise ou coupe le réseau sortant de l'utilisateur `agent`. */
  setNetwork(enabled: boolean): Promise<void>;

  /** Arrête la VM proprement. */
  stop(): Promise<void>;

  /** Supprime puis recrée la VM (bouton « Réinitialiser la VM »). */
  reset(onProgress?: (progress: SandboxProgress) => void): Promise<void>;

  /** État courant. */
  status(): SandboxStatus;

  /** Diagnostic détaillé. */
  diagnostics(): Promise<SandboxDiagnostics>;

  /**
   * Convertit un chemin hôte (dans le dossier de travail, un dossier rattaché ou
   * les skills) en chemin VM. Renvoie `null` si le chemin n'est pas visible dans la VM.
   */
  toGuestPath(hostPath: string): string | null;

  /** Convertit un chemin VM (`/workspace/...`, `/dossiers/<nom>/...`) en chemin hôte, ou `null`. */
  toHostPath(guestPath: string): string | null;
}
