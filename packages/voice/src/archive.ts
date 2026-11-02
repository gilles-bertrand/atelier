/**
 * Contrôle et extraction des archives de modèles (ADR-004 D5, étapes 4 et 5).
 *
 * L'archive n'est extraite qu'après le contrôle de son SHA-256. On vérifie
 * ensuite deux fois qu'elle contient exactement les fichiers du catalogue :
 * - avant l'extraction, sur la liste des entrées (`tar -tf`) : aucun chemin
 *   absolu, aucun `..`, aucune entrée inattendue ;
 * - après l'extraction, sur le disque : fichiers ordinaires seulement (ni lien
 *   symbolique, ni lien physique, ni périphérique), tailles exactes.
 */
import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { VoiceModelFile } from './catalog.js';

/** Résultat d'un appel à `tar`. */
export interface TarResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Lance `tar` avec ces arguments, **sans shell**. Injecté pour les tests. */
export type TarRunner = (args: readonly string[], signal?: AbortSignal) => Promise<TarResult>;

/** Sortie de `tar` gardée au plus (la liste d'un modèle tient en quelques Ko). */
const MAX_TAR_OUTPUT = 4 * 1024 * 1024;

/** `tar` du système (bsdtar sur macOS), lancé par `spawn` sans shell. */
export const systemTar: TarRunner = (args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn('tar', [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { signal } : {}),
    });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length + chunk.length > MAX_TAR_OUTPUT) {
        overflow = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (overflow) {
        reject(new Error('Sortie de tar trop longue.'));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });

/** Arguments de `tar` pour lister une archive (compression détectée par tar). */
export function tarListArgs(archive: string): string[] {
  return ['-tf', archive];
}

/** Arguments de `tar` pour extraire une archive dans `dest`, sans propriétaire ni droits d'origine. */
export function tarExtractArgs(archive: string, dest: string): string[] {
  return ['-xf', archive, '-C', dest, '--no-same-owner', '--no-same-permissions'];
}

/**
 * Vérifie la liste des entrées d'une archive (sortie de `tar -tf`).
 * Renvoie le premier problème, en français, ou `undefined`.
 *
 * Acceptés : le dossier racine, les dossiers parents des fichiers attendus et
 * les fichiers attendus (chemins relatifs à `rootDir`). Tous les fichiers
 * attendus doivent figurer dans l'archive.
 */
export function checkArchiveEntries(
  entries: readonly string[],
  rootDir: string,
  files: readonly VoiceModelFile[],
): string | undefined {
  const expectedFiles = new Set(files.map((file) => `${rootDir}/${file.path}`));
  const allowedDirs = new Set<string>([rootDir]);
  for (const file of expectedFiles) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) allowedDirs.add(parts.slice(0, i).join('/'));
  }
  const seen = new Set<string>();
  for (const raw of entries) {
    if (raw === '') continue;
    if (raw.startsWith('/')) return `Chemin absolu dans l'archive : ${raw}`;
    const isDir = raw.endsWith('/');
    const name = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (name === '' || name === '.') continue;
    const segments = name.split('/');
    if (segments.some((s) => s === '..' || s === '.' || s === '' || s.includes('\\'))) {
      return `Chemin interdit dans l'archive : ${raw}`;
    }
    if (expectedFiles.has(name) && !isDir) {
      seen.add(name);
      continue;
    }
    if (allowedDirs.has(name)) continue;
    return `Fichier inattendu dans l'archive : ${raw}`;
  }
  for (const file of expectedFiles) {
    if (!seen.has(file)) return `Fichier manquant dans l'archive : ${file}`;
  }
  return undefined;
}

/**
 * Vérifie un dossier extrait : exactement les fichiers attendus, ordinaires,
 * sans lien, aux tailles du catalogue. Renvoie le premier problème ou `undefined`.
 */
export async function checkExtractedTree(
  dir: string,
  files: readonly VoiceModelFile[],
): Promise<string | undefined> {
  const expected = new Map(files.map((file) => [file.path, file.bytes]));
  const found = new Set<string>();
  const walk = async (relative: string): Promise<string | undefined> => {
    const entries = await readdir(join(dir, relative));
    for (const name of entries) {
      const rel = relative === '' ? name : `${relative}/${name}`;
      const info = await lstat(join(dir, rel));
      if (info.isDirectory()) {
        const issue = await walk(rel);
        if (issue !== undefined) return issue;
        continue;
      }
      if (!info.isFile()) return `Entrée qui n'est pas un fichier ordinaire : ${rel}`;
      if (info.nlink !== 1) return `Lien physique interdit : ${rel}`;
      const bytes = expected.get(rel);
      if (bytes === undefined) return `Fichier inattendu : ${rel}`;
      if (info.size !== bytes) {
        return `Taille inattendue pour ${rel} : ${String(info.size)} octets au lieu de ${String(bytes)}`;
      }
      found.add(rel);
    }
    return undefined;
  };
  const issue = await walk('');
  if (issue !== undefined) return issue;
  for (const path of expected.keys()) {
    if (!found.has(path)) return `Fichier manquant : ${path}`;
  }
  return undefined;
}
