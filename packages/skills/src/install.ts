/**
 * Installation des skills d'exemple livrés avec l'app dans le dossier des skills
 * de l'utilisateur (sans jamais écraser un skill existant ou modifié).
 */
import { cp, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dossier des skills d'exemple dans le dépôt (en production : ressources de l'app). */
export function bundledExamplesDir(): string {
  return fileURLToPath(new URL('../examples', import.meta.url));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copie chaque skill de `sourceDir` absent de `targetDir`.
 * @returns Les noms de dossiers installés.
 */
export async function installExampleSkills(
  sourceDir: string,
  targetDir: string,
): Promise<string[]> {
  const installed: string[] = [];
  for (const entry of (await readdir(sourceDir)).sort()) {
    if (entry.startsWith('.')) continue;
    const from = join(sourceDir, entry);
    const to = join(targetDir, entry);
    if (!(await stat(from)).isDirectory() || (await exists(to))) continue;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    installed.push(entry);
  }
  return installed;
}
