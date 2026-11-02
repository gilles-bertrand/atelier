/**
 * Télécharge les modèles de voix **embarqués** dans l'app (ADR-004 D4) :
 * Silero VAD, copié dans `Contents/Resources/voice` par electron-builder. Le
 * modèle de reconnaissance (Parakeet) n'est pas embarqué : l'app le télécharge
 * au premier usage (`VoiceModelManager`).
 *
 * Usage : `pnpm fetch:voice` (idempotent ; `--force` pour retélécharger).
 *
 * Sécurité : empreinte SHA-256 épinglée ICI, identique à `SILERO_VAD` dans
 * `packages/voice/src/catalog.ts` (un test le vérifie). Comme `fetch-lima.ts`,
 * ce script tourne directement avec Node : pas d'import local.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Fichiers embarqués : nom, URL officielle, taille et SHA-256 (catalogue de l'app). */
export const BUNDLED_VOICE_MODELS = [
  {
    file: 'silero_vad.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    bytes: 643_854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  },
] as const;

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

async function fileMatches(path: string, expected: string): Promise<boolean> {
  try {
    return sha256(await readFile(path)) === expected;
  } catch {
    return false;
  }
}

/** Télécharge et vérifie les modèles embarqués dans `destDir`. */
export async function fetchVoiceModels(
  destDir: string,
  options: { force?: boolean } = {},
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const model of BUNDLED_VOICE_MODELS) {
    const target = join(destDir, model.file);
    if (!options.force && (await fileMatches(target, model.sha256))) {
      console.log(`${model.file} déjà présent dans ${destDir}`);
      continue;
    }
    console.log(`Téléchargement de ${model.url}`);
    const response = await fetch(model.url, { redirect: 'follow' });
    if (!response.ok)
      throw new Error(`Téléchargement impossible (${String(response.status)}) : ${model.url}`);
    const data = new Uint8Array(await response.arrayBuffer());
    const actual = sha256(data);
    if (data.byteLength !== model.bytes || actual !== model.sha256) {
      throw new Error(
        `Empreinte invalide pour ${model.file} : attendu ${model.sha256}, obtenu ${actual}`,
      );
    }
    const tmp = `${target}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
    console.log(`${model.file} vérifié et installé dans ${destDir}`);
  }
}

/** Dossier de destination par défaut, relatif à la racine du dépôt. */
export function defaultVoiceDestDir(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return join(repoRoot, 'apps/desktop/resources/voice');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  fetchVoiceModels(defaultVoiceDestDir(), { force: process.argv.includes('--force') }).catch(
    async (error: unknown) => {
      await rm(join(defaultVoiceDestDir(), 'silero_vad.onnx.tmp'), { force: true });
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
