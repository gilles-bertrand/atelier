/**
 * Progression lisible de la préparation de la VM, à partir du journal de limactl
 * et des marqueurs `::atelier:: <pourcentage> <message>` des scripts de provisioning.
 */
import type { SandboxPhase, SandboxProgress } from '@atelier/shared';

/** Plage de progression globale (0..1) de chaque étape. */
export const PHASE_RANGES: Record<SandboxPhase, readonly [number, number]> = {
  checking: [0, 0.02],
  creating: [0.02, 0.05],
  downloading_image: [0.05, 0.3],
  starting: [0.3, 0.4],
  provisioning: [0.4, 0.95],
  configuring_mounts: [0.95, 0.98],
  ready: [1, 1],
};

/** Construit une progression ; `fraction` (0..1) est relative à l'étape. */
export function progressAt(phase: SandboxPhase, message: string, fraction = 0): SandboxProgress {
  const [from, to] = PHASE_RANGES[phase];
  const clamped = Math.min(1, Math.max(0, fraction));
  return { phase, message, progress: Math.round((from + (to - from) * clamped) * 1000) / 1000 };
}

/** Règles de correspondance message limactl → étape (première qui correspond). */
const LIMA_RULES: readonly {
  test: RegExp;
  phase: SandboxPhase;
  message: string;
  fraction?: number;
}[] = [
  {
    test: /attempting to download the image/i,
    phase: 'downloading_image',
    message: "Téléchargement de l'image Ubuntu (environ 600 Mo)…",
  },
  {
    test: /using cache/i,
    phase: 'downloading_image',
    message: 'Image Ubuntu déjà téléchargée.',
    fraction: 1,
  },
  {
    test: /downloaded the image/i,
    phase: 'downloading_image',
    message: 'Image Ubuntu téléchargée.',
    fraction: 1,
  },
  {
    test: /converting|expanding|creating (an? )?(disk|diffdisk)/i,
    phase: 'creating',
    message: 'Préparation du disque de la VM…',
    fraction: 0.5,
  },
  {
    test: /starting (the instance|vz|the vm)|\[hostagent\] starting/i,
    phase: 'starting',
    message: 'Démarrage de la VM…',
  },
  {
    test: /waiting for the essential requirement/i,
    phase: 'starting',
    message: 'Démarrage de Linux…',
    fraction: 0.4,
  },
  {
    test: /waiting for the optional requirement/i,
    phase: 'starting',
    message: 'Connexion à la VM…',
    fraction: 0.7,
  },
  {
    test: /waiting for the final requirement|boot scripts must have finished/i,
    phase: 'starting',
    message: 'Configuration du système au démarrage…',
    fraction: 0.85,
  },
  { test: /^ready\b|\bREADY\b/, phase: 'starting', message: 'VM démarrée.', fraction: 1 },
];

/** Traduit un message de journal limactl en progression, si pertinent. */
export function progressFromLimaMessage(msg: string): SandboxProgress | undefined {
  for (const rule of LIMA_RULES) {
    if (rule.test.test(msg)) return progressAt(rule.phase, rule.message, rule.fraction ?? 0);
  }
  return undefined;
}

/** Préfixe des marqueurs de progression écrits par `lima/provision/*.sh`. */
export const PROVISION_MARKER = '::atelier::';

/** Parse un marqueur `::atelier:: <0-100> <message>` ; `undefined` sinon. */
export function parseProvisionMarker(
  line: string,
): { percent: number; message: string } | undefined {
  const index = line.indexOf(PROVISION_MARKER);
  if (index === -1) return undefined;
  const match = /^\s*(\d{1,3})\s+(.+)$/.exec(line.slice(index + PROVISION_MARKER.length));
  if (!match?.[1] || !match[2]) return undefined;
  return { percent: Math.min(100, Number(match[1])), message: match[2].trim() };
}
