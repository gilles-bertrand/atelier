/**
 * Montages de la VM : `/workspace` (dossier de travail, écriture), les dossiers
 * rattachés d'un projet sous `/dossiers` (écriture ou lecture seule, ADR-003) et
 * `/skills` (lecture seule). Jamais le `$HOME` complet ni les données de Lima.
 */
import { homedir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';
import {
  AtelierError,
  GUEST_FOLDERS,
  GUEST_SKILLS,
  GUEST_WORKSPACE,
  type SandboxFolderMount,
} from '@atelier/shared';
import type { LimaMount } from './limactl.js';
import { isInside } from './paths.js';

/** Montages voulus. */
export interface DesiredMounts {
  workspace?: string;
  skillsDir: string;
  /** Dossiers rattachés d'un projet, montés sous `/dossiers`. */
  folders?: readonly SandboxFolderMount[];
}

/** Expression yq (`limactl --set`) qui remplace tous les montages. */
export function mountsSetExpression(mounts: DesiredMounts): string {
  const list: LimaMount[] = [];
  if (mounts.workspace) {
    list.push({ location: mounts.workspace, mountPoint: GUEST_WORKSPACE, writable: true });
  }
  for (const folder of mounts.folders ?? []) {
    list.push({ location: folder.host, mountPoint: folder.guest, writable: folder.writable });
  }
  list.push({ location: mounts.skillsDir, mountPoint: GUEST_SKILLS, writable: false });
  // JSON est un sous-ensemble de la syntaxe yq : chaînes correctement échappées.
  return `.mounts = ${JSON.stringify(list)}`;
}

/**
 * Vrai si `mountPoint` est un point de montage de dossier rattaché :
 * `/dossiers/<nom>`, nom sans `/`, sans point de tête (ni `.` ni `..`).
 */
export function isFolderMountPoint(mountPoint: string | undefined): boolean {
  if (mountPoint === undefined || !mountPoint.startsWith(`${GUEST_FOLDERS}/`)) return false;
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(mountPoint.slice(GUEST_FOLDERS.length + 1));
}

/** Montages actuels d'une instance, lus depuis sa configuration. */
export function currentMounts(mounts: readonly LimaMount[]): Partial<DesiredMounts> {
  const result: Partial<DesiredMounts> = {};
  const folders: SandboxFolderMount[] = [];
  for (const mount of mounts) {
    if (mount.mountPoint === GUEST_WORKSPACE && mount.writable === true) {
      result.workspace = mount.location;
    }
    if (mount.mountPoint === GUEST_SKILLS && mount.writable !== true) {
      result.skillsDir = mount.location;
    }
    if (mount.mountPoint !== undefined && isFolderMountPoint(mount.mountPoint)) {
      folders.push({
        host: mount.location,
        guest: mount.mountPoint,
        writable: mount.writable === true,
      });
    }
  }
  if (folders.length > 0) result.folders = folders;
  return result;
}

/** Clé d'un dossier rattaché pour comparer deux listes sans tenir compte de l'ordre. */
function folderKey(folder: SandboxFolderMount): string {
  return `${folder.guest}\0${folder.host}\0${folder.writable ? 'rw' : 'ro'}`;
}

/** Vrai si les deux listes de dossiers rattachés sont identiques (ordre indifférent). */
export function sameFolderMounts(
  a: readonly SandboxFolderMount[] = [],
  b: readonly SandboxFolderMount[] = [],
): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(folderKey));
  return b.every((folder) => keys.has(folderKey(folder)));
}

/** Vrai si la configuration de l'instance correspond exactement aux montages voulus. */
export function mountsMatch(actual: readonly LimaMount[], desired: DesiredMounts): boolean {
  const folders = desired.folders ?? [];
  const expected = (desired.workspace ? 2 : 1) + folders.length;
  const current = currentMounts(actual);
  return (
    actual.length === expected &&
    current.skillsDir === desired.skillsDir &&
    current.workspace === desired.workspace &&
    sameFolderMounts(current.folders, folders)
  );
}

/**
 * Refuse les dossiers de travail dangereux : racine, `$HOME` lui-même, données de
 * Lima (disque de la VM) ou dossier des skills.
 */
export function assertMountableWorkspace(
  hostDir: string,
  forbidden: { limaHome: string; skillsDir: string; home?: string },
): void {
  const refuse = (reason: string): never => {
    throw new AtelierError('sandbox/invalid_workspace', `Dossier de travail refusé : ${reason}`, {
      details: { hostDir },
    });
  };
  if (!isAbsolute(hostDir)) refuse('le chemin doit être absolu.');
  const dir = resolve(hostDir);
  const home = resolve(forbidden.home ?? homedir());
  if (dir === parse(dir).root) refuse('la racine du disque ne peut pas être partagée avec la VM.');
  if (dir === home || isInside(dir, home)) {
    refuse(
      'le dossier personnel complet ne peut pas être partagé avec la VM ; choisissez un sous-dossier.',
    );
  }
  if (isInside(forbidden.limaHome, dir) || isInside(dir, forbidden.limaHome)) {
    refuse('ce dossier contient les données internes de la VM.');
  }
  if (isInside(forbidden.skillsDir, dir) || isInside(dir, forbidden.skillsDir)) {
    refuse('le dossier des skills est déjà partagé en lecture seule.');
  }
}

/**
 * Refuse un dossier rattaché dangereux ou mal formé : mêmes règles que le
 * dossier de travail ({@link assertMountableWorkspace}), point de montage
 * `/dossiers/<nom>` (nom sans `/` ni `..`), aucun dossier contenu dans un autre
 * ni dans le dossier de travail (sinon un dossier en lecture seule serait
 * modifiable par le montage de son parent), points de montage uniques.
 */
export function assertMountableFolders(
  workspace: string | undefined,
  folders: readonly SandboxFolderMount[],
  forbidden: { limaHome: string; skillsDir: string; home?: string },
): void {
  const refuse = (hostDir: string, reason: string): never => {
    throw new AtelierError('sandbox/invalid_workspace', `Dossier rattaché refusé : ${reason}`, {
      details: { hostDir },
    });
  };
  const guests = new Set<string>();
  for (const [index, folder] of folders.entries()) {
    assertMountableWorkspace(folder.host, forbidden);
    if (!isFolderMountPoint(folder.guest)) {
      refuse(folder.host, `point de montage invalide (${folder.guest}).`);
    }
    if (guests.has(folder.guest)) {
      refuse(folder.host, `deux dossiers seraient montés sur ${folder.guest}.`);
    }
    guests.add(folder.guest);
    const host = resolve(folder.host);
    if (workspace !== undefined && (isInside(workspace, host) || isInside(host, workspace))) {
      refuse(folder.host, 'il contient le dossier de travail ou se trouve dedans.');
    }
    for (const other of folders.slice(index + 1)) {
      const otherHost = resolve(other.host);
      if (isInside(host, otherHost) || isInside(otherHost, host)) {
        refuse(other.host, `il est inclus dans ${folder.host}, ou l'inverse.`);
      }
    }
  }
}
