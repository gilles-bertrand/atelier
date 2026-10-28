/**
 * Vérification stricte des chemins : tout accès fichier de l'agent doit rester
 * dans le dossier de travail autorisé, liens symboliques compris.
 *
 * Exposé publiquement : `packages/documents` s'en sert pour `read_file` / `look_at`.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AtelierError } from '@atelier/shared';

/** Résultat d'une résolution de chemin réussie. */
export interface ResolvedWorkspacePath {
  /** Chemin absolu canonique (symlinks résolus pour la partie existante). */
  absolutePath: string;
  /** Chemin relatif au dossier de travail (`.` pour la racine), séparateurs `/`. */
  relativePath: string;
  /** Vrai si le chemin existe déjà sur le disque. */
  exists: boolean;
}

/** Vrai si `child` est `parent` ou se trouve dessous (chemins absolus normalisés). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/**
 * Résout la partie existante la plus longue d'un chemin via `realpath` (ce qui
 * suit les symlinks), puis recolle les segments qui n'existent pas encore.
 */
async function canonicalize(absolute: string): Promise<{ canonical: string; exists: boolean }> {
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return { canonical: path.join(real, ...pending.reverse()), exists: pending.length === 0 };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return { canonical: absolute, exists: false };
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Résout `input` (relatif au dossier de travail ou absolu) et vérifie qu'il reste
 * dans `workspace`, y compris après résolution des liens symboliques.
 *
 * Les segments inexistants (fichier à créer) sont acceptés : seul leur ancêtre
 * existant le plus proche est canonicalisé, ce qui bloque un symlink
 * intermédiaire pointant hors du dossier.
 *
 * @param workspace - Dossier de travail autorisé (absolu).
 * @param input - Chemin fourni par le modèle.
 * @throws AtelierError `tool/path_outside_workspace` si le chemin sort du dossier,
 *   `tool/invalid_input` si le chemin est vide ou contient un octet nul.
 */
export async function resolveWorkspacePath(
  workspace: string,
  input: string,
): Promise<ResolvedWorkspacePath> {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.includes('\0')) {
    throw new AtelierError('tool/invalid_input', `Chemin invalide : "${input}"`);
  }
  const lexicalRoot = path.resolve(workspace);
  const root = (await canonicalize(lexicalRoot)).canonical;
  // `~` n'a pas de sens pour l'agent : on le traite littéralement (relatif au dossier).
  // Un chemin absolu peut désigner le dossier par son nom lexical (ex. /var/… sur
  // macOS) ou canonique (/private/var/…) : la seule vérification qui compte est
  // celle du chemin canonique ci-dessous (`path.resolve` a déjà normalisé les `..`).
  const absolute = path.resolve(lexicalRoot, trimmed);
  const { canonical, exists } = await canonicalize(absolute);
  if (!isInside(root, canonical)) {
    throw outside(input);
  }
  const relativePath = path.relative(root, canonical).split(path.sep).join('/') || '.';
  return { absolutePath: canonical, relativePath, exists };
}

function outside(input: string): AtelierError {
  return new AtelierError(
    'tool/path_outside_workspace',
    `Accès refusé : « ${input} » est en dehors du dossier de travail.`,
    { details: { path: input } },
  );
}

/** Variante non levante : renvoie `null` si le chemin est refusé. */
export async function tryResolveWorkspacePath(
  workspace: string,
  input: string,
): Promise<ResolvedWorkspacePath | null> {
  try {
    return await resolveWorkspacePath(workspace, input);
  } catch (error) {
    if (error instanceof AtelierError) return null;
    throw error;
  }
}
