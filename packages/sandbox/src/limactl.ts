/**
 * Enveloppe typée de `limactl` (Lima embarqué) : construit les arguments, injecte
 * `LIMA_HOME` et traduit les échecs en `AtelierError`.
 */
import { classifyLimaFailure, parseLimaLogLine, type LimaLogEntry } from './errors.js';
import { spawnRunner, type CommandRunner, type RunOptions, type RunResult } from './runner.js';

/** Montage tel que décrit dans la configuration d'une instance Lima. */
export interface LimaMount {
  location: string;
  mountPoint?: string;
  writable?: boolean;
}

/** Instance telle que rapportée par `limactl list --json` (champs utiles). */
export interface LimaInstance {
  name: string;
  /** `Running`, `Stopped`, `Broken`… */
  status: string;
  dir?: string;
  vmType?: string;
  arch?: string;
  cpus?: number;
  /** Octets. */
  memory?: number;
  /** Octets. */
  disk?: number;
  sshLocalPort?: number;
  message?: string;
  errors?: string[];
  mounts: LimaMount[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseMounts(config: Record<string, unknown> | undefined): LimaMount[] {
  const raw = config?.['mounts'];
  if (!Array.isArray(raw)) return [];
  const mounts: LimaMount[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const location = optionalString(record?.['location']);
    if (!record || location === undefined) continue;
    const mountPoint = optionalString(record['mountPoint']);
    const writable = record['writable'];
    mounts.push({
      location,
      ...(mountPoint === undefined ? {} : { mountPoint }),
      ...(typeof writable === 'boolean' ? { writable } : {}),
    });
  }
  return mounts;
}

/** Convertit un objet JSON de `limactl list --json` ; `undefined` s'il est invalide. */
export function parseLimaInstance(value: unknown): LimaInstance | undefined {
  const record = asRecord(value);
  const name = optionalString(record?.['name']);
  const status = optionalString(record?.['status']);
  if (!record || name === undefined || status === undefined) return undefined;
  const errors = record['errors'];
  const instance: LimaInstance = { name, status, mounts: parseMounts(asRecord(record['config'])) };
  const fields = {
    dir: optionalString(record['dir']),
    vmType: optionalString(record['vmType']),
    arch: optionalString(record['arch']),
    cpus: optionalNumber(record['cpus']),
    memory: optionalNumber(record['memory']),
    disk: optionalNumber(record['disk']),
    sshLocalPort: optionalNumber(record['sshLocalPort']),
    message: optionalString(record['message']),
  };
  for (const [key, val] of Object.entries(fields)) {
    if (val !== undefined) Object.assign(instance, { [key]: val });
  }
  if (Array.isArray(errors)) instance.errors = errors.map(String);
  return instance;
}

/**
 * Parse la sortie de `limactl list --json` : un objet JSON par ligne (format actuel)
 * ou un tableau JSON.
 */
export function parseLimaList(stdout: string): LimaInstance[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  const values: unknown[] = [];
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) values.push(...(parsed as unknown[]));
  } else {
    for (const line of trimmed.split('\n')) {
      if (line.trim() !== '') values.push(JSON.parse(line) as unknown);
    }
  }
  return values.map(parseLimaInstance).filter((i): i is LimaInstance => i !== undefined);
}

/** Ressources demandées à la création ou à l'édition. */
export interface LimaResources {
  cpus?: number;
  memoryGiB?: number;
  diskGiB?: number;
}

function resourceFlags(resources: LimaResources): string[] {
  const flags: string[] = [];
  if (resources.cpus !== undefined) flags.push(`--cpus=${String(resources.cpus)}`);
  if (resources.memoryGiB !== undefined) flags.push(`--memory=${String(resources.memoryGiB)}`);
  if (resources.diskGiB !== undefined) flags.push(`--disk=${String(resources.diskGiB)}`);
  return flags;
}

/** Options de la classe {@link Limactl}. */
export interface LimactlOptions {
  /** Chemin du binaire `limactl` embarqué. */
  limactlPath: string;
  /** `LIMA_HOME` (données des VM). */
  limaHome: string;
  /** Lanceur de processus (mock en test). */
  runner?: CommandRunner;
  /** Environnement de base (défaut : `process.env`). */
  baseEnv?: NodeJS.ProcessEnv;
}

/** Options des commandes longues (create/start). */
export interface LimaLongRunOptions {
  /** Reçoit le journal structuré de limactl. */
  onLog?: (entry: LimaLogEntry) => void;
  signal?: AbortSignal;
}

/** Options de `limactl shell`. */
export interface LimaShellOptions extends Omit<RunOptions, 'env'> {
  workdir?: string;
}

/** Pilote `limactl` avec un `LIMA_HOME` dédié. */
export class Limactl {
  readonly limactlPath: string;
  readonly limaHome: string;
  private readonly runner: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: LimactlOptions) {
    this.limactlPath = options.limactlPath;
    this.limaHome = options.limaHome;
    this.runner = options.runner ?? spawnRunner;
    // Pas de couleurs ni d'interaction : sorties analysables.
    this.env = { ...(options.baseEnv ?? process.env), LIMA_HOME: options.limaHome, NO_COLOR: '1' };
  }

  /** Lance limactl avec l'environnement Lima. */
  run(args: readonly string[], options: Omit<RunOptions, 'env'> = {}): Promise<RunResult> {
    return this.runner(this.limactlPath, args, { ...options, env: this.env });
  }

  private async runOrThrow(
    args: readonly string[],
    action: string,
    options: Omit<RunOptions, 'env'> = {},
  ): Promise<RunResult> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) throw classifyLimaFailure(result.stderr.render().text, action);
    return result;
  }

  private logOptions(options: LimaLongRunOptions): Omit<RunOptions, 'env'> {
    const { onLog, signal } = options;
    return {
      ...(signal ? { signal } : {}),
      onStderrLine: (line) => {
        const entry = parseLimaLogLine(line);
        if (entry) onLog?.(entry);
      },
    };
  }

  /** Version de limactl (`limactl --version`). */
  async version(): Promise<string> {
    const result = await this.runOrThrow(['--version'], 'lire la version de Lima');
    const text = result.stdout.render().text.trim();
    return /version\s+(\S+)/.exec(text)?.[1] ?? text;
  }

  /** Liste les instances. */
  async list(): Promise<LimaInstance[]> {
    const result = await this.runOrThrow(['list', '--json'], 'lister les VM');
    return parseLimaList(result.stdout.render().text);
  }

  /** Instance par nom, ou `undefined` si elle n'existe pas. */
  async get(name: string): Promise<LimaInstance | undefined> {
    return (await this.list()).find((instance) => instance.name === name);
  }

  /** Crée une instance depuis un template (sans la démarrer). */
  async create(
    name: string,
    templatePath: string,
    resources: LimaResources,
    sets: readonly string[],
    options: LimaLongRunOptions = {},
  ): Promise<void> {
    await this.runOrThrow(
      [
        'create',
        '--tty=false',
        '--log-format=json',
        `--name=${name}`,
        ...resourceFlags(resources),
        ...sets.map((expr) => `--set=${expr}`),
        templatePath,
      ],
      'créer la VM',
      this.logOptions(options),
    );
  }

  /** Démarre une instance existante et attend qu'elle soit prête. */
  async start(name: string, timeout: string, options: LimaLongRunOptions = {}): Promise<void> {
    await this.runOrThrow(
      ['start', '--tty=false', '--log-format=json', `--timeout=${timeout}`, name],
      'démarrer la VM',
      this.logOptions(options),
    );
  }

  /** Arrête une instance (`force` : arrêt immédiat, sans extinction propre). */
  async stop(name: string, force = false): Promise<void> {
    await this.runOrThrow(
      ['stop', '--tty=false', '--log-format=json', ...(force ? ['--force'] : []), name],
      'arrêter la VM',
    );
  }

  /** Supprime une instance (et son disque). */
  async delete(name: string, force = true): Promise<void> {
    await this.runOrThrow(
      ['delete', '--tty=false', '--log-format=json', ...(force ? ['--force'] : []), name],
      'supprimer la VM',
    );
  }

  /** Modifie la configuration d'une instance arrêtée. */
  async edit(name: string, resources: LimaResources, sets: readonly string[]): Promise<void> {
    await this.runOrThrow(
      [
        'edit',
        '--tty=false',
        '--log-format=json',
        ...resourceFlags(resources),
        ...sets.map((expr) => `--set=${expr}`),
        name,
      ],
      'modifier la configuration de la VM',
    );
  }

  /**
   * `limactl shell [--workdir W] <name> -- <args…>` : les arguments sont échappés par
   * limactl avant d'être passés au shell de la VM.
   */
  shell(name: string, args: readonly string[], options: LimaShellOptions = {}): Promise<RunResult> {
    const { workdir, ...runOptions } = options;
    return this.run(
      ['shell', '--tty=false', ...(workdir ? [`--workdir=${workdir}`] : []), name, '--', ...args],
      runOptions,
    );
  }
}
