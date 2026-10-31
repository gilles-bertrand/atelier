/**
 * Vérification stricte des chemins : tout accès fichier de l'agent doit rester
 * dans le dossier de travail autorisé, liens symboliques compris.
 *
 * Exposé publiquement : `packages/documents` s'en sert pour `read_file` / `look_at`.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  AtelierError,
  folderGuestName,
  folderGuestPath,
  GUEST_WORKSPACE,
  type WorkspaceFolder,
} from '@atelier/shared';

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

/**
 * Dossier lisible hors du dossier de travail, en **lecture seule** : la racine
 * des skills (#60). `guest` est le même dossier vu depuis la VM (`/skills`) :
 * un chemin VM est ramené au chemin hôte correspondant.
 */
export interface ReadRoot {
  /** Chemin absolu côté hôte. */
  host: string;
  /** Chemin absolu dans la VM (POSIX), s'il existe. */
  guest?: string;
}

/** Résolution pour la lecture : dans le dossier de travail, ou sous une {@link ReadRoot}. */
export interface ResolvedReadablePath extends ResolvedWorkspacePath {
  /** Vrai si le chemin est sous une racine en lecture seule (hors dossier de travail). */
  readOnly: boolean;
}

/** Racines de lecture des skills : dossier parent de chaque `<skill>/SKILL.md` (dédoublonné). */
export function skillReadRoots(
  skills: readonly { path: string; guestPath?: string }[],
): ReadRoot[] {
  const roots = new Map<string, ReadRoot>();
  for (const skill of skills) {
    const host = path.dirname(path.dirname(skill.path));
    if (roots.has(host)) continue;
    roots.set(host, {
      host,
      ...(skill.guestPath !== undefined
        ? { guest: path.posix.dirname(path.posix.dirname(skill.guestPath)) }
        : {}),
    });
  }
  return [...roots.values()];
}

/** Chemins hôtes candidats de `input` sous `root` : absolu, chemin VM, ou `skills/…` relatif. */
function readRootCandidates(root: ReadRoot, input: string): string[] {
  const candidates: string[] = [];
  if (path.isAbsolute(input)) {
    candidates.push(path.resolve(input));
    if (root.guest !== undefined) {
      const rel = path.posix.relative(root.guest, path.posix.normalize(input));
      if (rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel))) {
        candidates.push(path.join(root.host, ...rel.split('/')));
      }
    }
    return candidates;
  }
  // Relatif : seulement « skills/xlsx/SKILL.md » (nom du dossier racine en tête),
  // ce que Qwen tente quand il ne retrouve pas le chemin absolu (#60).
  const segments = path.normalize(input).split(path.sep);
  if (segments[0] === path.basename(root.host)) {
    candidates.push(path.join(root.host, ...segments.slice(1)));
  }
  return candidates;
}

/**
 * Comme {@link resolveWorkspacePath}, pour un outil de **lecture** : accepte en
 * plus, en lecture seule, un chemin sous l'une des `readRoots` (racine des
 * skills), désigné par son chemin hôte, son chemin VM ou un chemin relatif
 * `skills/<nom>/…` introuvable dans le dossier de travail. La vérification se
 * fait sur le chemin canonique (`realpath`) : ni `..` ni lien symbolique ne
 * permettent de sortir de la racine. Les outils d'écriture n'utilisent jamais
 * cette fonction.
 *
 * @throws AtelierError `tool/path_outside_workspace` si le chemin n'est ni dans le
 *   dossier de travail ni sous une racine de lecture.
 */
export async function resolveReadablePath(
  workspace: string,
  input: string,
  readRoots: readonly ReadRoot[] = [],
): Promise<ResolvedReadablePath> {
  let inWorkspace: ResolvedWorkspacePath | undefined;
  let refusal: unknown;
  try {
    inWorkspace = await resolveWorkspacePath(workspace, input);
    if (inWorkspace.exists || readRoots.length === 0) return { ...inWorkspace, readOnly: false };
  } catch (error) {
    if (!(error instanceof AtelierError) || error.code !== 'tool/path_outside_workspace') {
      throw error;
    }
    refusal = error;
  }
  const trimmed = input.trim();
  for (const root of readRoots) {
    const rootCanonical = (await canonicalize(path.resolve(root.host))).canonical;
    for (const candidate of readRootCandidates(root, trimmed)) {
      const { canonical, exists } = await canonicalize(candidate);
      if (!exists || !isInside(rootCanonical, canonical)) continue;
      return { absolutePath: canonical, relativePath: canonical, exists, readOnly: true };
    }
  }
  if (inWorkspace !== undefined) return { ...inWorkspace, readOnly: false };
  throw refusal;
}

// ---------------------------------------------------------------------------
// Dossiers multiples d'un projet (ADR-003 D1)

/** Dossier principal et dossiers rattachés d'une conversation (voir `ToolExecutionContext`). */
export interface FolderContext {
  /** Dossier principal : racine des chemins relatifs. */
  workspace: string;
  /** Dossiers rattachés du projet ; absent ou vide : seul le principal. */
  folders?: readonly WorkspaceFolder[];
}

/** Résolution dans l'un des dossiers d'une conversation. */
export interface ResolvedFolderPath extends ResolvedReadablePath {
  /**
   * Dossier rattaché qui contient le chemin ; absent : dossier principal (ou
   * racine des skills, `readOnly`). `relativePath` est alors préfixé par son
   * libellé (« Compta/bilan.xlsx »).
   */
  folder?: WorkspaceFolder;
}

/** Options de {@link resolveFolderPath}. */
export interface ResolveFolderOptions {
  /** Écriture : refuse un dossier rattaché en lecture seule (`tool/read_only`) et les skills. */
  write?: boolean;
  /** Lecture seule : racines lisibles en plus des dossiers (skills, #60). */
  readRoots?: readonly ReadRoot[];
}

/** Chemin POSIX relatif à `root` s'il est dessous (`''` pour `root` lui-même), sinon `undefined`. */
function posixInside(root: string, target: string): string | undefined {
  const rel = path.posix.relative(root, path.posix.normalize(target));
  return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel)) ? rel : undefined;
}

/** Dossier rattaché désigné par un premier segment de chemin (libellé ou nom dans la VM). */
function folderByLabel(
  folders: readonly WorkspaceFolder[],
  segment: string,
): WorkspaceFolder | undefined {
  const wanted = segment.toLocaleLowerCase('fr');
  return folders.find(
    (f) =>
      f.label.trim().toLocaleLowerCase('fr') === wanted ||
      folderGuestName(f.label).toLowerCase() === segment.toLowerCase(),
  );
}

/** Résultat dans un dossier rattaché : chemin affiché préfixé par le libellé. */
function inFolder(folder: WorkspaceFolder, resolved: ResolvedWorkspacePath): ResolvedFolderPath {
  const label = folder.label.trim();
  return {
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath === '.' ? label : `${label}/${resolved.relativePath}`,
    exists: resolved.exists,
    readOnly: folder.access === 'read',
    folder,
  };
}

/** Dossier d'un chemin absolu : principal, puis dossiers rattachés, puis chemins de la VM. */
async function locateAbsolute(
  workspace: string,
  folders: readonly WorkspaceFolder[],
  input: string,
): Promise<ResolvedFolderPath | undefined> {
  const inPrimary = await tryResolveWorkspacePath(workspace, input);
  if (inPrimary) return { ...inPrimary, readOnly: false };
  for (const folder of folders) {
    const resolved = await tryResolveWorkspacePath(folder.path, input);
    if (resolved) return inFolder(folder, resolved);
  }
  // Chemin vu depuis la VM (/workspace/…, /dossiers/<nom>/…) : ramené au chemin hôte.
  const guestRel = posixInside(GUEST_WORKSPACE, input);
  if (guestRel !== undefined) {
    const resolved = await tryResolveWorkspacePath(workspace, guestRel === '' ? '.' : guestRel);
    if (resolved) return { ...resolved, readOnly: false };
  }
  for (const folder of folders) {
    const rel = posixInside(folder.guestPath ?? folderGuestPath(folder.label), input);
    if (rel === undefined) continue;
    const resolved = await tryResolveWorkspacePath(folder.path, rel === '' ? '.' : rel);
    if (resolved) return inFolder(folder, resolved);
  }
  return undefined;
}

/**
 * Dossier d'un chemin relatif : le principal ; sinon, si le premier segment
 * n'existe pas dans le principal et désigne un dossier rattaché par son
 * libellé (« Compta/bilan.xlsx »), ce dossier.
 */
async function locateRelative(
  workspace: string,
  folders: readonly WorkspaceFolder[],
  input: string,
): Promise<ResolvedFolderPath | undefined> {
  const primary = await tryResolveWorkspacePath(workspace, input);
  if (primary?.exists) return { ...primary, readOnly: false };
  const segments = input.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  const first = segments[0];
  if (first !== undefined && first !== '..') {
    const folder = folderByLabel(folders, first);
    const firstInPrimary = await tryResolveWorkspacePath(workspace, first);
    if (folder && !firstInPrimary?.exists) {
      const rest = segments.slice(1).join('/');
      const resolved = await tryResolveWorkspacePath(folder.path, rest === '' ? '.' : rest);
      return resolved ? inFolder(folder, resolved) : undefined;
    }
  }
  return primary ? { ...primary, readOnly: false } : undefined;
}

function outsideFolders(
  input: string,
  workspace: string,
  folders: readonly WorkspaceFolder[],
): AtelierError {
  const allowed = [
    `dossier principal (${workspace})`,
    ...folders.map(
      (f) => `${f.label.trim()} (${f.path}${f.access === 'read' ? ', lecture seule' : ''})`,
    ),
  ].join(' ; ');
  return new AtelierError(
    'tool/path_outside_workspace',
    `Accès refusé : « ${input} » est en dehors des dossiers du projet. Dossiers accessibles : ${allowed}.`,
    { details: { path: input } },
  );
}

/** Écriture refusée dans un dossier en lecture seule. */
function readOnlyFolder(folder: WorkspaceFolder, input: string): AtelierError {
  return new AtelierError(
    'tool/read_only',
    `Le dossier « ${folder.label.trim()} » est en lecture seule : tu peux y lire, pas y écrire (« ${input} »). Écris dans le dossier principal ou dans un dossier en lecture et écriture.`,
    { details: { path: input, folder: folder.path } },
  );
}

/**
 * Résout un chemin donné par le modèle dans les dossiers d'une conversation
 * (ADR-003 D1) :
 * 1. relatif : depuis le dossier principal ; s'il n'y existe pas et que son
 *    premier segment est le libellé d'un dossier rattaché, depuis ce dossier ;
 * 2. absolu : dans le principal ou dans un dossier rattaché (chemin canonique,
 *    liens symboliques compris) ;
 * 3. chemin VM (`/workspace/…`, `/dossiers/<nom>/…`) : ramené au chemin hôte ;
 * 4. en lecture seulement : sous une racine de lecture (skills).
 *
 * Sans dossiers rattachés, le comportement est exactement celui de
 * {@link resolveWorkspacePath} (écriture) ou {@link resolveReadablePath} (lecture).
 *
 * @throws AtelierError `tool/path_outside_workspace` hors des dossiers,
 *   `tool/read_only` pour une écriture dans un dossier en lecture seule,
 *   `tool/invalid_input` pour un chemin vide.
 */
export async function resolveFolderPath(
  context: FolderContext,
  input: string,
  options: ResolveFolderOptions = {},
): Promise<ResolvedFolderPath> {
  const folders = context.folders ?? [];
  const readRoots = options.write === true ? [] : (options.readRoots ?? []);
  if (folders.length === 0) {
    return options.write === true
      ? { ...(await resolveWorkspacePath(context.workspace, input)), readOnly: false }
      : resolveReadablePath(context.workspace, input, readRoots);
  }
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.includes('\0')) {
    throw new AtelierError('tool/invalid_input', `Chemin invalide : "${input}"`);
  }
  const found = path.isAbsolute(trimmed)
    ? await locateAbsolute(context.workspace, folders, trimmed)
    : await locateRelative(context.workspace, folders, trimmed);
  if (found?.folder && found.folder.access === 'read' && options.write === true) {
    throw readOnlyFolder(found.folder, input);
  }
  if (found && options.write === true) {
    // Un dossier en lecture seule peut aussi être atteint par un autre dossier
    // (lien symbolique vers un sous-dossier du principal) : chemin canonique.
    for (const folder of folders) {
      if (folder.access !== 'read') continue;
      const root = (await canonicalize(path.resolve(folder.path))).canonical;
      if (isInside(root, found.absolutePath)) throw readOnlyFolder(folder, input);
    }
  }
  if (found && (found.exists || readRoots.length === 0)) return found;
  if (readRoots.length > 0) {
    // Skills en lecture seule : seulement si le chemin n'existe dans aucun dossier.
    try {
      const skill = await resolveReadablePath(context.workspace, trimmed, readRoots);
      if (skill.readOnly) return skill;
    } catch (error) {
      if (!(error instanceof AtelierError)) throw error;
    }
  }
  if (found) return found;
  throw outsideFolders(input, context.workspace, folders);
}
