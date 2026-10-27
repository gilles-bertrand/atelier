/**
 * Emplacements et correspondances de chemins hôte ↔ VM (fonctions pures).
 */
import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

/** `LIMA_HOME` d'Atelier (brief §3). */
export function defaultLimaHome(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'Atelier', 'lima');
}

/** Dossier des skills par défaut (brief §5). */
export function defaultSkillsDir(home: string = homedir()): string {
  return join(home, 'Atelier', 'skills');
}

/** Un dossier partagé avec la VM. */
export interface MountMapping {
  /** Chemin absolu côté hôte. */
  host: string;
  /** Point de montage dans la VM. */
  guest: string;
}

/** Vrai si `child` est `parent` ou se trouve dessous (chemins hôte absolus). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/** Convertit un chemin hôte en chemin VM selon les montages ; `null` s'il n'est pas visible. */
export function hostToGuest(hostPath: string, mounts: readonly MountMapping[]): string | null {
  if (!isAbsolute(hostPath)) return null;
  for (const mount of mounts) {
    if (!isInside(mount.host, hostPath)) continue;
    const rel = relative(resolve(mount.host), resolve(hostPath));
    return rel === '' ? mount.guest : posix.join(mount.guest, ...rel.split(sep));
  }
  return null;
}

/** Convertit un chemin VM en chemin hôte selon les montages ; `null` s'il n'est pas monté. */
export function guestToHost(guestPath: string, mounts: readonly MountMapping[]): string | null {
  if (!guestPath.startsWith('/')) return null;
  const normalized = posix.normalize(guestPath);
  for (const mount of mounts) {
    const rel = posix.relative(mount.guest, normalized);
    if (rel === '') return resolve(mount.host);
    if (rel.startsWith('..') || posix.isAbsolute(rel)) continue;
    return join(resolve(mount.host), ...rel.split('/'));
  }
  return null;
}
