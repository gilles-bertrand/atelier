/**
 * Implémentation de l'interface `Sandbox` (`@atelier/shared`) avec Lima (vz, virtiofs).
 *
 * Les opérations de cycle de vie (ensureReady, setWorkspace, setNetwork, stop, reset)
 * sont sérialisées ; `exec` peut tourner en parallèle quand la VM est prête.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { access, constants, mkdir, realpath, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  AtelierError,
  GUEST_SKILLS,
  GUEST_WORKSPACE,
  isAtelierError,
  type Sandbox,
  type SandboxDiagnostics,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxProgress,
  type SandboxResources,
  type SandboxState,
  type SandboxStatus,
} from '@atelier/shared';
import { classifyLimaFailure } from './errors.js';
import { Limactl, type LimaInstance } from './limactl.js';
import { assertMountableWorkspace, mountsMatch, mountsSetExpression } from './mounts.js';
import { DEFAULT_MAX_OUTPUT_BYTES, splitOutputBudget } from './output.js';
import {
  chooseLimaHome,
  defaultSkillsDir,
  guestToHost,
  hostToGuest,
  limaSocketFits,
  limaSocketPath,
  UNIX_PATH_MAX,
  type MountMapping,
} from './paths.js';
import { parseProvisionMarker, progressAt, progressFromLimaMessage } from './progress.js';
import {
  PROVISION_STAMP_PATH,
  loadProvisionScripts,
  provisionBundle,
  provisionVersion,
} from './provision.js';
import { spawnRunner, type CommandRunner } from './runner.js';

/** Nom de l'instance Lima. */
export const DEFAULT_INSTANCE_NAME = 'atelier';
/** Ressources par défaut (brief §3). */
export const DEFAULT_RESOURCES: SandboxResources = { cpus: 4, memoryGiB: 4, diskGiB: 30 };
/** Délai d'exécution par défaut d'une commande (brief §2). */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
/** Espace disque minimal pour créer la VM (image + provisioning). */
export const MIN_FREE_BYTES_FOR_CREATE = 10 * 1024 ** 3;

const GUEST_EXEC = '/usr/local/bin/atelier-exec';
const GUEST_KILL = '/usr/local/bin/atelier-kill';
const GUEST_NETWORK = '/usr/local/sbin/atelier-network';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Marge laissée à `timeout` dans la VM avant que l'hôte ne tue limactl. */
const HOST_TIMEOUT_GRACE_MS = 15_000;

/** Options de {@link LimaSandbox}. */
export interface LimaSandboxOptions {
  /** Binaire `limactl` embarqué (`Contents/Resources/lima/bin/limactl`). */
  limactlPath: string;
  /** Dossier contenant `atelier.yaml` et `provision/` (`lima/` du dépôt ou `lima-templates`). */
  templatesDir: string;
  /**
   * `LIMA_HOME` (défaut : `~/Library/Application Support/Atelier/lima`, ou
   * `~/.atelier-lima` si le socket de Lima y serait trop long ; voir `chooseLimaHome`).
   */
  limaHome?: string;
  /** Dossier des skills monté sur `/skills` (défaut : `~/Atelier/skills`). */
  skillsDir?: string;
  /** Nom de l'instance (défaut : `atelier`). */
  instanceName?: string;
  /** Ressources de la VM (Réglages). */
  resources?: Partial<SandboxResources>;
  /** Réseau de `agent` autorisé au départ (défaut : non). */
  networkEnabled?: boolean;
  /** Délai de `limactl start` (format Go, défaut `30m` : premier démarrage compris). */
  startTimeout?: string;
  /** Lanceur de processus (mock en test). */
  runner?: CommandRunner;
  /** Espace libre (octets) du volume contenant `path` (injectable pour les tests). */
  freeDiskBytes?: (path: string) => Promise<number>;
  /** Plateforme hôte (injectable pour les tests). */
  platform?: { os: NodeJS.Platform; arch: string };
  /** Journal technique (durées, étapes). */
  log?: (message: string) => void;
}

async function defaultFreeDiskBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}

/** Sandbox Lima d'Atelier. */
export class LimaSandbox implements Sandbox {
  private readonly limactl: Limactl;
  private readonly runner: CommandRunner;
  private readonly name: string;
  private readonly templatesDir: string;
  private skillsDir: string;
  private readonly resources: SandboxResources;
  private readonly startTimeout: string;
  private readonly freeDiskBytes: (path: string) => Promise<number>;
  private readonly platform: { os: NodeJS.Platform; arch: string };
  private readonly log: (message: string) => void;

  private state: SandboxState = 'stopped';
  private error: string | undefined;
  /** Dossier réellement monté sur /workspace (VM démarrée). */
  private mountedWorkspace: string | undefined;
  /** Dossier voulu, appliqué au prochain démarrage. */
  private desiredWorkspace: string | undefined;
  private networkEnabled: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private limaVersion: string | undefined;
  private readonly timings: Record<string, number> = {};

  constructor(options: LimaSandboxOptions) {
    this.runner = options.runner ?? spawnRunner;
    this.log = options.log ?? (() => undefined);
    this.name = options.instanceName ?? DEFAULT_INSTANCE_NAME;
    this.limactl = new Limactl({
      limactlPath: options.limactlPath,
      limaHome: options.limaHome ?? chooseLimaHome(this.name),
      runner: this.runner,
      log: (message) => {
        this.log(message);
      },
    });
    this.templatesDir = options.templatesDir;
    this.skillsDir = options.skillsDir ?? defaultSkillsDir();
    this.resources = { ...DEFAULT_RESOURCES, ...options.resources };
    this.networkEnabled = options.networkEnabled ?? false;
    this.startTimeout = options.startTimeout ?? '30m';
    this.freeDiskBytes = options.freeDiskBytes ?? defaultFreeDiskBytes;
    this.platform = options.platform ?? { os: process.platform, arch: process.arch };
  }

  /** `LIMA_HOME` utilisé. */
  get limaHome(): string {
    return this.limactl.limaHome;
  }

  // ---------------------------------------------------------------------------
  // Cycle de vie

  ensureReady(onProgress?: (progress: SandboxProgress) => void): Promise<void> {
    return this.serialize(() => this.doEnsureReady(onProgress ?? (() => undefined)));
  }

  async setWorkspace(hostDir: string): Promise<void> {
    assertMountableWorkspace(hostDir, { limaHome: this.limaHome, skillsDir: this.skillsDir });
    let dir: string;
    try {
      dir = await realpath(hostDir);
    } catch (cause) {
      throw new AtelierError('tool/failed', `Dossier de travail introuvable : ${hostDir}`, {
        cause,
      });
    }
    // Le chemin résolu (liens symboliques) doit lui aussi être acceptable.
    assertMountableWorkspace(dir, { limaHome: this.limaHome, skillsDir: this.skillsDir });
    return this.serialize(async () => {
      this.desiredWorkspace = dir;
      if (this.state !== 'ready') return; // appliqué au prochain ensureReady
      if (this.mountedWorkspace === dir) return; // rien à faire : pas de redémarrage
      const started = Date.now();
      this.state = 'restarting';
      try {
        await this.limactl.stop(this.name);
        this.timings['lastStopMs'] = Date.now() - started;
        await this.applyConfig();
        await this.bootAndSetup(() => undefined, false);
        this.timings['lastWorkspaceSwitchMs'] = Date.now() - started;
        this.log(`Changement de dossier en ${String(this.timings['lastWorkspaceSwitchMs'])} ms`);
      } catch (error) {
        throw this.fail(error);
      }
    });
  }

  setNetwork(enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      this.networkEnabled = enabled;
      if (this.state === 'ready') await this.applyNetwork();
    });
  }

  stop(): Promise<void> {
    return this.serialize(async () => {
      const instance = await this.limactl.get(this.name);
      if (instance?.status === 'Running') await this.limactl.stop(this.name);
      this.mountedWorkspace = undefined;
      this.state = instance ? 'stopped' : 'absent';
      this.error = undefined;
    });
  }

  reset(onProgress?: (progress: SandboxProgress) => void): Promise<void> {
    return this.serialize(async () => {
      const report = onProgress ?? (() => undefined);
      report(progressAt('checking', 'Suppression de la VM…'));
      const instance = await this.limactl.get(this.name);
      if (instance) await this.limactl.delete(this.name, true);
      this.mountedWorkspace = undefined;
      this.state = 'absent';
      await this.doEnsureReady(report);
    });
  }

  status(): SandboxStatus {
    return {
      state: this.state,
      ...(this.mountedWorkspace ? { workspace: this.mountedWorkspace } : {}),
      networkEnabled: this.networkEnabled,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async diagnostics(): Promise<SandboxDiagnostics> {
    const diagnostics: SandboxDiagnostics = {
      limaHome: this.limaHome,
      resources: { ...this.resources },
      extra: { instanceName: this.name, skillsDir: this.skillsDir, timings: { ...this.timings } },
    };
    try {
      this.limaVersion ??= await this.limactl.version();
      diagnostics.limaVersion = this.limaVersion;
      const instance = await this.limactl.get(this.name);
      diagnostics.rawStatus = instance?.status ?? 'Absent';
      if (instance) {
        diagnostics.extra = {
          ...diagnostics.extra,
          instance: {
            vmType: instance.vmType,
            arch: instance.arch,
            cpus: instance.cpus,
            memoryBytes: instance.memory,
            diskBytes: instance.disk,
            mounts: instance.mounts,
            errors: instance.errors,
          },
        };
      }
    } catch (error) {
      diagnostics.extra = {
        ...diagnostics.extra,
        diagnosticsError: error instanceof Error ? error.message : String(error),
      };
    }
    return diagnostics;
  }

  // ---------------------------------------------------------------------------
  // Exécution

  async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    if (this.state !== 'ready') {
      throw new AtelierError(
        'sandbox/not_ready',
        "La VM n'est pas prête : réessayez dans un instant.",
        {
          retryable: true,
          details: { state: this.state },
        },
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const envArgs = Object.entries(options.env ?? {}).map(([key, value]) => {
      if (!ENV_NAME.test(key)) {
        throw new AtelierError(
          'tool/invalid_input',
          `Nom de variable d'environnement invalide : ${key}`,
        );
      }
      return `${key}=${value}`;
    });
    const id = randomUUID();
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const args = [
      'sudo',
      '-u',
      'agent',
      '-H',
      '--',
      ...(envArgs.length > 0 ? ['env', ...envArgs] : []),
      GUEST_EXEC,
      id,
      String(timeoutSec),
      command,
    ];

    const onAbort = (): void => {
      void this.killGuestCommand(id);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let result;
    try {
      result = await this.limactl.shell(this.name, args, {
        workdir: options.cwd ?? GUEST_WORKSPACE,
        timeoutMs: timeoutMs + HOST_TIMEOUT_GRACE_MS,
        captureBytes: maxOutput,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (result.aborted) {
      throw new AtelierError('agent/aborted', 'Commande annulée.');
    }
    if (result.timedOut) void this.killGuestCommand(id);
    const stderrText = result.stderr.render().text;
    if (result.exitCode === 255 && isSshFailure(stderrText)) {
      throw new AtelierError('sandbox/not_ready', 'Connexion à la VM impossible.', {
        retryable: true,
        details: { stderr: stderrText.slice(-1000) },
      });
    }

    // `timeout` (coreutils) renvoie 124 au délai, 137 si le KILL a été nécessaire.
    const guestTimedOut =
      (result.exitCode === 124 || result.exitCode === 137) && result.durationMs >= timeoutMs - 1000;
    const timedOut = result.timedOut || guestTimedOut;
    const budget = splitOutputBudget(result.stdout.size, result.stderr.size, maxOutput);
    const stdout = result.stdout.render(budget.stdout);
    const stderr = result.stderr.render(budget.stderr);
    return {
      exitCode: timedOut ? null : result.exitCode,
      stdout: stdout.text,
      stderr: timedOut
        ? `${stderr.text}${stderr.text.endsWith('\n') || stderr.text === '' ? '' : '\n'}[commande interrompue après ${String(timeoutSec)} s]`
        : stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
      durationMs: result.durationMs,
    };
  }

  toGuestPath(hostPath: string): string | null {
    const mappings = this.mountMappings();
    return hostToGuest(hostPath, mappings) ?? hostToGuest(resolveExisting(hostPath), mappings);
  }

  toHostPath(guestPath: string): string | null {
    return guestToHost(guestPath, this.mountMappings());
  }

  // ---------------------------------------------------------------------------
  // Interne

  private mountMappings(): MountMapping[] {
    const mappings: MountMapping[] = [];
    if (this.mountedWorkspace)
      mappings.push({ host: this.mountedWorkspace, guest: GUEST_WORKSPACE });
    mappings.push({ host: this.skillsDir, guest: GUEST_SKILLS });
    return mappings;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private fail(error: unknown): AtelierError {
    const atelierError = isAtelierError(error)
      ? error
      : new AtelierError('sandbox/failed', error instanceof Error ? error.message : String(error), {
          cause: error,
        });
    this.state = 'error';
    this.error = atelierError.message;
    return atelierError;
  }

  private async doEnsureReady(report: (progress: SandboxProgress) => void): Promise<void> {
    const started = Date.now();
    try {
      report(progressAt('checking', 'Vérification de la machine…'));
      await this.preflight();
      const instance = await this.limactl.get(this.name);

      if (!instance) {
        this.state = 'absent';
        await this.create(report);
        await this.bootAndSetup(report, true);
      } else if (instance.status === 'Running') {
        if (this.state === 'ready' && mountsMatch(instance.mounts, this.desired())) {
          report(progressAt('ready', 'VM prête.'));
          return;
        }
        if (!mountsMatch(instance.mounts, this.desired())) {
          report(progressAt('configuring_mounts', 'Mise à jour des dossiers partagés…'));
          this.state = 'restarting';
          await this.limactl.stop(this.name);
          await this.applyConfig();
          await this.bootAndSetup(report, true);
        } else {
          // VM déjà démarrée (app relancée) : on vérifie juste le provisioning et le réseau.
          await this.setupRunning(report, instance);
        }
      } else if (instance.status === 'Stopped') {
        await this.applyConfig(instance);
        await this.bootAndSetup(report, true);
      } else {
        throw new AtelierError(
          'sandbox/failed',
          `La VM est dans un état inattendu (${instance.status}). Réinitialisez-la depuis les Réglages.`,
          { details: { status: instance.status, errors: instance.errors } },
        );
      }
      this.timings['lastEnsureReadyMs'] = Date.now() - started;
      report(progressAt('ready', 'VM prête.'));
    } catch (error) {
      throw this.fail(error);
    }
  }

  private desired(): { workspace?: string; skillsDir: string } {
    return {
      ...(this.desiredWorkspace ? { workspace: this.desiredWorkspace } : {}),
      skillsDir: this.skillsDir,
    };
  }

  private async preflight(): Promise<void> {
    if (this.platform.os !== 'darwin' || this.platform.arch !== 'arm64') {
      throw new AtelierError(
        'sandbox/virtualization_unavailable',
        'La VM Atelier nécessite un Mac Apple Silicon (macOS 14 ou plus).',
        { details: this.platform },
      );
    }
    const hv = await this.runner('/usr/sbin/sysctl', ['-n', 'kern.hv_support']);
    if (hv.exitCode !== 0 || hv.stdout.render().text.trim() !== '1') {
      throw new AtelierError(
        'sandbox/virtualization_unavailable',
        "La virtualisation n'est pas disponible sur ce Mac (kern.hv_support = 0). Atelier ne peut pas tourner dans une VM sans virtualisation imbriquée.",
      );
    }
    try {
      await access(this.limactl.limactlPath, constants.X_OK);
    } catch (cause) {
      throw new AtelierError(
        'sandbox/failed',
        `limactl est introuvable (${this.limactl.limactlPath}). Lancez \`pnpm fetch:lima\` ou réinstallez l'application.`,
        { cause },
      );
    }
    if (!limaSocketFits(this.limaHome, this.name)) {
      const socket = limaSocketPath(this.limaHome, this.name);
      throw new AtelierError(
        'sandbox/failed',
        `Le dossier de la VM (${this.limaHome}) a un chemin trop long pour macOS : le socket de la VM ferait ${String(socket.length)} caractères, ${String(UNIX_PATH_MAX - 1)} au plus. Cela arrive avec un dossier personnel au chemin très long. Contactez le support ou utilisez un compte macOS au nom plus court.`,
        { details: { limaHome: this.limaHome, socketPath: socket, length: socket.length } },
      );
    }
    await mkdir(this.limaHome, { recursive: true });
    await mkdir(this.skillsDir, { recursive: true });
    this.skillsDir = await realpath(this.skillsDir);
  }

  private async create(report: (progress: SandboxProgress) => void): Promise<void> {
    const free = await this.freeDiskBytes(this.limaHome);
    if (free < MIN_FREE_BYTES_FOR_CREATE) {
      throw new AtelierError(
        'sandbox/disk_full',
        `Espace disque insuffisant pour créer la VM : ${formatGiB(free)} libres, 10 Go nécessaires.`,
        { details: { freeBytes: free } },
      );
    }
    report(progressAt('creating', 'Création de la VM…'));
    const started = Date.now();
    await this.limactl.create(
      this.name,
      join(this.templatesDir, 'atelier.yaml'),
      this.resources,
      [mountsSetExpression(this.desired())],
      {
        onLog: (entry) => {
          this.forwardLimaLog(entry.msg, report);
        },
      },
    );
    this.timings['lastCreateMs'] = Date.now() - started;
    this.state = 'stopped';
  }

  /** Applique montages et ressources à une instance arrêtée (si nécessaire). */
  private async applyConfig(instance?: LimaInstance): Promise<void> {
    const desired = this.desired();
    const sets =
      instance && mountsMatch(instance.mounts, desired) ? [] : [mountsSetExpression(desired)];
    const resources: { cpus?: number; memoryGiB?: number } = {};
    if (instance?.cpus !== undefined && instance.cpus !== this.resources.cpus) {
      resources.cpus = this.resources.cpus;
    }
    const memoryBytes = this.resources.memoryGiB * 1024 ** 3;
    if (instance?.memory !== undefined && instance.memory !== memoryBytes) {
      resources.memoryGiB = this.resources.memoryGiB;
    }
    if (sets.length === 0 && Object.keys(resources).length === 0) return;
    await this.limactl.edit(this.name, resources, sets);
  }

  /** Démarre l'instance arrêtée puis la rend utilisable. */
  private async bootAndSetup(
    report: (progress: SandboxProgress) => void,
    verbose: boolean,
  ): Promise<void> {
    this.state = this.state === 'restarting' ? 'restarting' : 'starting';
    report(progressAt('starting', 'Démarrage de la VM…'));
    const started = Date.now();
    await this.limactl.start(this.name, this.startTimeout, {
      onLog: (entry) => {
        if (verbose) this.forwardLimaLog(entry.msg, report);
      },
    });
    this.timings['lastStartMs'] = Date.now() - started;
    const instance = await this.limactl.get(this.name);
    if (!instance)
      throw new AtelierError('sandbox/failed', 'La VM a disparu pendant son démarrage.');
    await this.setupRunning(report, instance);
  }

  /** Provisioning (si besoin), réseau, puis état « prête ». */
  private async setupRunning(
    report: (progress: SandboxProgress) => void,
    instance: LimaInstance,
  ): Promise<void> {
    await this.ensureProvisioned(report);
    this.mountedWorkspace = this.desiredWorkspace;
    const mounted = instance.mounts.find((m) => m.mountPoint === GUEST_WORKSPACE);
    if (mounted) this.mountedWorkspace = mounted.location;
    report(progressAt('configuring_mounts', 'Application des règles réseau…', 0.5));
    await this.applyNetwork();
    this.state = 'ready';
    this.error = undefined;
  }

  private async ensureProvisioned(report: (progress: SandboxProgress) => void): Promise<void> {
    const scripts = await loadProvisionScripts(join(this.templatesDir, 'provision'));
    const version = provisionVersion(scripts);
    const stamp = await this.limactl.shell(this.name, ['cat', PROVISION_STAMP_PATH]);
    if (stamp.exitCode === 0 && stamp.stdout.render().text.trim() === version) return;

    this.state = 'provisioning';
    report(progressAt('provisioning', 'Installation des outils dans la VM (premier lancement)…'));
    const started = Date.now();
    const result = await this.limactl.shell(this.name, ['sudo', 'bash', '-s'], {
      input: provisionBundle(scripts, version),
      captureBytes: 64 * 1024,
      onStdoutLine: (line) => {
        const marker = parseProvisionMarker(line);
        if (marker) report(progressAt('provisioning', marker.message, marker.percent / 100));
      },
    });
    this.timings['lastProvisionMs'] = Date.now() - started;
    if (result.exitCode !== 0) {
      const failure = classifyLimaFailure(
        result.stderr.render().text,
        'installer les outils dans la VM',
      );
      throw new AtelierError(
        failure.code,
        `${failure.message} Le provisioning sera repris au prochain lancement.`,
        { retryable: true, ...(failure.details ? { details: failure.details } : {}) },
      );
    }
  }

  private async applyNetwork(): Promise<void> {
    const mode = this.networkEnabled ? 'on' : 'off';
    const result = await this.limactl.shell(this.name, ['sudo', GUEST_NETWORK, mode]);
    if (result.exitCode !== 0 || result.stdout.render().text.trim() !== mode) {
      throw new AtelierError(
        'sandbox/failed',
        `Impossible d'appliquer la règle réseau (${mode}) dans la VM.`,
        { details: { stderr: result.stderr.render().text.slice(-1000) } },
      );
    }
  }

  private async killGuestCommand(id: string): Promise<void> {
    try {
      await this.limactl.shell(this.name, ['sudo', '-u', 'agent', '-H', '--', GUEST_KILL, id], {
        timeoutMs: 15_000,
      });
    } catch {
      // Au mieux : la VM peut être en train de s'arrêter.
    }
  }

  private forwardLimaLog(msg: string, report: (progress: SandboxProgress) => void): void {
    const progress = progressFromLimaMessage(msg);
    if (progress) report(progress);
  }
}

/**
 * Résout les liens symboliques de la partie existante d'un chemin (ex. `/var` →
 * `/private/var` sur macOS), le reste étant recollé tel quel.
 */
function resolveExisting(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    missing.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync.native(current), ...missing);
  } catch {
    return path;
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
}

function isSshFailure(stderr: string): boolean {
  return /ssh: connect to host|Connection (refused|closed|reset)|kex_exchange_identification|Permission denied \(publickey/i.test(
    stderr,
  );
}
