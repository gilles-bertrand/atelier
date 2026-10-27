/**
 * Télécharge une version épinglée de Lima (darwin-arm64) dans
 * `apps/desktop/resources/lima/`, pour que l'app embarque `limactl` et le guest agent
 * (copiés dans `Contents/Resources/lima` par electron-builder).
 *
 * Usage : `pnpm fetch:lima` (idempotent ; `--force` pour retélécharger).
 *
 * Sécurité : l'archive est vérifiée contre un SHA-256 épinglé ICI (et non lu dans le
 * SHA256SUMS de la release, qui ne protégerait que contre la corruption).
 * Pour monter de version : changer `LIMA_VERSION` et `LIMA_SHA256` (valeur de la ligne
 * `lima-<version>-Darwin-arm64.tar.gz` du SHA256SUMS de la release), puis relancer.
 *
 * Ce script s'exécute directement avec Node (suppression des types) : pas d'import
 * local, pas de syntaxe TypeScript non effaçable.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Version de Lima embarquée. */
export const LIMA_VERSION = '2.2.1';
/** SHA-256 de `lima-<version>-Darwin-arm64.tar.gz`. */
export const LIMA_SHA256 = '9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e';

/** Fichiers extraits de l'archive (le reste : nerdctl, docker, templates… est inutile). */
export const LIMA_FILES = [
  'bin/limactl',
  'share/lima/lima-guestagent.Linux-aarch64.gz',
  'share/doc/lima/LICENSE',
] as const;

/** URL de l'archive darwin-arm64 pour une version. */
export function limaArchiveUrl(version: string): string {
  return `https://github.com/lima-vm/lima/releases/download/v${version}/lima-${version}-Darwin-arm64.tar.gz`;
}

/** Contenu du fichier témoin écrit après une installation réussie. */
export function stampContent(version: string, sha256: string): string {
  return `${JSON.stringify({ version, sha256 })}\n`;
}

/**
 * Cherche le SHA-256 d'un fichier dans un `SHA256SUMS` (format `sha256sum`).
 * Utile pour préparer une montée de version ; renvoie `undefined` si absent.
 */
export function findChecksum(sums: string, fileName: string): string | undefined {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === fileName) return match[1];
  }
  return undefined;
}

/** SHA-256 hexadécimal d'un fichier. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Téléchargement impossible (${String(response.status)}) : ${url}`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  let lastLog = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (total > 0 && now - lastLog > 1000) {
      lastLog = now;
      process.stdout.write(`  ${String(Math.round((received / total) * 100))} %\r`);
    }
  });
  await pipeline(body, createWriteStream(dest));
}

/** Télécharge, vérifie et extrait Lima dans `destDir`. */
export async function fetchLima(destDir: string, options: { force?: boolean } = {}): Promise<void> {
  const stampPath = join(destDir, 'VERSION.json');
  const expectedStamp = stampContent(LIMA_VERSION, LIMA_SHA256);
  if (!options.force && (await exists(stampPath))) {
    const current = await readFile(stampPath, 'utf8');
    const complete = await Promise.all(LIMA_FILES.map((f) => exists(join(destDir, f))));
    if (current === expectedStamp && complete.every(Boolean)) {
      console.log(`Lima ${LIMA_VERSION} déjà présent dans ${destDir}`);
      return;
    }
  }

  const work = await mkdtemp(join(tmpdir(), 'atelier-lima-'));
  let stagingDir: string | undefined;
  try {
    const archive = join(work, 'lima.tar.gz');
    const url = limaArchiveUrl(LIMA_VERSION);
    console.log(`Téléchargement de ${url}`);
    await download(url, archive);

    const actual = await sha256File(archive);
    if (actual !== LIMA_SHA256) {
      throw new Error(
        `Checksum invalide pour Lima ${LIMA_VERSION} : attendu ${LIMA_SHA256}, obtenu ${actual}`,
      );
    }
    console.log('Checksum SHA-256 vérifié');

    // Staging à côté de la destination (même volume) pour un `rename` atomique.
    await mkdir(dirname(destDir), { recursive: true });
    const staging = await mkdtemp(join(dirname(destDir), '.lima-staging-'));
    stagingDir = staging;
    const tar = spawnSync(
      'tar',
      ['-xzf', archive, '-C', staging, ...LIMA_FILES.map((f) => `./${f}`)],
      { stdio: 'inherit' },
    );
    if (tar.status !== 0) throw new Error(`Extraction échouée (tar, code ${String(tar.status)})`);
    await chmod(join(staging, 'bin/limactl'), 0o755);
    await writeFile(join(staging, 'VERSION.json'), expectedStamp);

    // Remplacement du dossier en une fois : pas d'état à moitié installé.
    await rm(destDir, { recursive: true, force: true });
    await rename(staging, destDir);
    stagingDir = undefined;
    console.log(`Lima ${LIMA_VERSION} installé dans ${destDir}`);
  } finally {
    await rm(work, { recursive: true, force: true });
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
  }
}

/** Dossier de destination par défaut, relatif à la racine du dépôt. */
export function defaultDestDir(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return join(repoRoot, 'apps/desktop/resources/lima');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.warn(
      'Avertissement : Atelier cible macOS Apple Silicon ; Lima darwin-arm64 téléchargé.',
    );
  }
  fetchLima(defaultDestDir(), { force: process.argv.includes('--force') }).catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
