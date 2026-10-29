/**
 * Emplacements et correspondances de chemins hôte ↔ VM (fonctions pures).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

/** `LIMA_HOME` d'Atelier par défaut (brief §3). */
export function defaultLimaHome(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'Atelier', 'lima');
}

/**
 * `LIMA_HOME` de repli, court mais propre à l'utilisateur, quand le chemin par
 * défaut rend le socket SSH de Lima trop long (issue #46). Jamais `/tmp`, qui
 * est partagé entre les comptes et vidé par le système.
 */
export function fallbackLimaHome(home: string = homedir()): string {
  return join(home, '.atelier-lima');
}

/**
 * Lima refuse un chemin de socket Unix de `UNIX_PATH_MAX` (104 sur macOS)
 * caractères ou plus : la longueur doit rester strictement inférieure.
 */
export const UNIX_PATH_MAX = 104;

/** Suffixe du socket SSH mesuré par Lima (`ssh.sock.` + 16 chiffres). */
const SSH_SOCKET_NAME = `ssh.sock.${'0'.repeat(16)}`;

/** Chemin du socket SSH tel que Lima le mesure avant de créer l'instance. */
export function limaSocketPath(limaHome: string, instanceName: string): string {
  return join(limaHome, instanceName, SSH_SOCKET_NAME);
}

/** Vrai si Lima accepte de créer `instanceName` sous ce `LIMA_HOME`. */
export function limaSocketFits(limaHome: string, instanceName: string): boolean {
  return limaSocketPath(limaHome, instanceName).length < UNIX_PATH_MAX;
}

/**
 * Choisit le `LIMA_HOME` d'Atelier.
 *
 * 1. Une instance existante reste où elle est (défaut, puis repli) : on ne perd
 *    jamais une VM déjà créée.
 * 2. Sinon, le chemin par défaut s'il est assez court : rien ne change pour les
 *    installations actuelles.
 * 3. Sinon, le repli court (`~/.atelier-lima`).
 *
 * Le choix ne dépend que du dossier personnel et de ce qui existe déjà : il est
 * le même à chaque lancement. Si même le repli est trop long, il est renvoyé
 * quand même et le preflight de la VM lève une erreur claire.
 */
export function chooseLimaHome(
  instanceName: string,
  options: { home?: string; exists?: (path: string) => boolean } = {},
): string {
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;
  const preferred = defaultLimaHome(home);
  const fallback = fallbackLimaHome(home);
  if (exists(join(preferred, instanceName))) return preferred;
  if (exists(join(fallback, instanceName))) return fallback;
  return limaSocketFits(preferred, instanceName) ? preferred : fallback;
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
