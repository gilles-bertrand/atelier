/**
 * Montages de la VM : `/workspace` (dossier de travail, écriture) et `/skills`
 * (lecture seule). Jamais le `$HOME` complet ni les données de Lima.
 */
import { homedir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';
import { AtelierError, GUEST_SKILLS, GUEST_WORKSPACE } from '@atelier/shared';
import type { LimaMount } from './limactl.js';
import { isInside } from './paths.js';

/** Montages voulus. */
export interface DesiredMounts {
  workspace?: string;
  skillsDir: string;
}

/** Expression yq (`limactl --set`) qui remplace tous les montages. */
export function mountsSetExpression(mounts: DesiredMounts): string {
  const list: LimaMount[] = [];
  if (mounts.workspace) {
    list.push({ location: mounts.workspace, mountPoint: GUEST_WORKSPACE, writable: true });
  }
  list.push({ location: mounts.skillsDir, mountPoint: GUEST_SKILLS, writable: false });
  // JSON est un sous-ensemble de la syntaxe yq : chaînes correctement échappées.
  return `.mounts = ${JSON.stringify(list)}`;
}

/** Montages actuels d'une instance, lus depuis sa configuration. */
export function currentMounts(mounts: readonly LimaMount[]): Partial<DesiredMounts> {
  const result: Partial<DesiredMounts> = {};
  for (const mount of mounts) {
    if (mount.mountPoint === GUEST_WORKSPACE && mount.writable === true) {
      result.workspace = mount.location;
    }
    if (mount.mountPoint === GUEST_SKILLS && mount.writable !== true) {
      result.skillsDir = mount.location;
    }
  }
  return result;
}

/** Vrai si la configuration de l'instance correspond exactement aux montages voulus. */
export function mountsMatch(actual: readonly LimaMount[], desired: DesiredMounts): boolean {
  const expected = desired.workspace ? 2 : 1;
  const current = currentMounts(actual);
  return (
    actual.length === expected &&
    current.skillsDir === desired.skillsDir &&
    current.workspace === desired.workspace
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
