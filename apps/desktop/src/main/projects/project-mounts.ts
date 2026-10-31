/**
 * Conversions pures entre un projet (ADR-003) et ce qu'en utilisent les outils,
 * la VM et le bail : dossiers rattachés avec leur chemin dans la VM, montages,
 * signature des montages, chemin affiché d'un fichier.
 */
import {
  folderGuestPath,
  isSameOrInside,
  type Project,
  type SandboxFolderMount,
  type WorkspaceFolder,
} from '@atelier/shared';

/** Dossiers rattachés d'un projet (tous sauf le principal), avec leur point de montage. */
export function attachedFolders(project: Project): WorkspaceFolder[] {
  return project.folders.slice(1).map((folder) => ({
    ...folder,
    guestPath: folderGuestPath(folder.label),
  }));
}

/** Montages de la VM pour des dossiers rattachés (lecture seule selon l'accès). */
export function sandboxMounts(folders: readonly WorkspaceFolder[]): SandboxFolderMount[] {
  return folders.map((folder) => ({
    host: folder.path,
    guest: folder.guestPath ?? folderGuestPath(folder.label),
    writable: folder.access === 'write',
  }));
}

/**
 * Signature de l'ensemble des montages (principal et dossiers rattachés, ordre
 * indifférent) : deux tours de même signature partagent la VM sans la remonter.
 */
export function mountSignature(workspace: string, folders: readonly WorkspaceFolder[]): string {
  const mounts = sandboxMounts(folders)
    .map((m) => `${m.guest}=${m.host}:${m.writable ? 'rw' : 'ro'}`)
    .sort();
  return [workspace, ...mounts].join('\n');
}

/**
 * Chemin affiché d'un fichier d'un projet : relatif au principal, ou préfixé par
 * le libellé de son dossier rattaché ; le chemin absolu sinon.
 */
export function displayPath(project: Project, absolutePath: string): string {
  for (const [index, folder] of project.folders.entries()) {
    if (!isSameOrInside(folder.path, absolutePath)) continue;
    const rel = absolutePath.slice(folder.path.replace(/\/+$/, '').length).replace(/^\/+/, '');
    if (index === 0) return rel === '' ? '.' : rel;
    return rel === '' ? folder.label : `${folder.label}/${rel}`;
  }
  return absolutePath;
}
