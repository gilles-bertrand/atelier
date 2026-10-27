/**
 * Provisioning piloté par l'hôte : les scripts `lima/provision/*.sh` sont concaténés
 * en un seul script bash envoyé sur l'entrée standard de `sudo bash -s` dans la VM.
 * Une empreinte des scripts est écrite dans la VM : on ne reprovisionne que si les
 * scripts ont changé (mise à jour de l'app) ou si le provisioning a échoué.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Fichier témoin du provisioning dans la VM. */
export const PROVISION_STAMP_PATH = '/var/lib/atelier/provisioned';

/** Script de provisioning. */
export interface ProvisionScript {
  name: string;
  content: string;
}

/** Charge `dir/*.sh`, triés par nom (préfixes numériques). */
export async function loadProvisionScripts(dir: string): Promise<ProvisionScript[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sh')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, content: await readFile(join(dir, name), 'utf8') })),
  );
}

/** Empreinte (sha256, 16 caractères) d'un ensemble de scripts. */
export function provisionVersion(scripts: readonly ProvisionScript[]): string {
  const hash = createHash('sha256');
  for (const script of scripts) {
    hash.update(script.name).update('\0').update(script.content).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Script bash unique : chaque script tourne dans son propre sous-shell (`set -e`
 * local), le témoin n'est écrit qu'en cas de succès complet.
 */
export function provisionBundle(scripts: readonly ProvisionScript[], version: string): string {
  if (!/^[0-9a-f]+$/.test(version))
    throw new Error(`Version de provisioning invalide : ${version}`);
  const parts = [
    '#!/bin/bash',
    'set -euo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    `rm -f ${PROVISION_STAMP_PATH}`,
  ];
  for (const script of scripts) {
    parts.push(
      `echo "=== ${script.name.replace(/[^\w.-]/g, '_')} ===" >&2`,
      '(',
      script.content,
      ')',
    );
  }
  parts.push(
    `mkdir -p ${PROVISION_STAMP_PATH.slice(0, PROVISION_STAMP_PATH.lastIndexOf('/'))}`,
    `echo ${version} > ${PROVISION_STAMP_PATH}`,
    'echo "::atelier:: 100 Provisioning terminé."',
  );
  return `${parts.join('\n')}\n`;
}
