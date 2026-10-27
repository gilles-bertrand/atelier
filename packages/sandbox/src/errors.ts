/**
 * Traduction des échecs de limactl en erreurs typées, avec un message français.
 */
import { AtelierError } from '@atelier/shared';

/** Entrée de journal de limactl (`--log-format json`). */
export interface LimaLogEntry {
  level: string;
  msg: string;
  /** Champs supplémentaires (error, fields…). */
  [key: string]: unknown;
}

/** Parse une ligne de journal JSON de limactl ; `undefined` si ce n'est pas du JSON. */
export function parseLimaLogLine(line: string): LimaLogEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const msg = record['msg'];
    const level = record['level'];
    if (typeof msg !== 'string') return undefined;
    return { ...record, level: typeof level === 'string' ? level : 'info', msg };
  } catch {
    return undefined;
  }
}

/** Message d'erreur le plus parlant d'une sortie limactl (dernière ligne error/fatal). */
export function lastLimaError(stderr: string): string | undefined {
  let found: string | undefined;
  for (const line of stderr.split('\n')) {
    const entry = parseLimaLogLine(line);
    if (entry && (entry.level === 'error' || entry.level === 'fatal')) {
      const detail = typeof entry['error'] === 'string' ? `: ${entry['error']}` : '';
      found = `${entry.msg}${detail}`;
    } else if (!entry && /\b(error|fatal|failed)\b/i.test(line)) {
      found = line.trim();
    }
  }
  return found;
}

const VIRTUALIZATION_PATTERNS = [
  /virtualization (framework )?(is )?(not available|unavailable|not supported)/i,
  /VZErrorDomain/,
  /kern\.hv_support/,
  /com\.apple\.security\.virtualization/,
  /vmType.*vz.*(not supported|requires)/i,
  /nested virtualization/i,
];
const DISK_PATTERNS = [
  /no space left on device/i,
  /\bENOSPC\b/,
  /not enough (free )?(disk )?space/i,
  /disk (is )?full/i,
];
const TIMEOUT_PATTERNS = [/did not reach the running state/i, /timed? ?out/i, /deadline exceeded/i];
const DOWNLOAD_PATTERNS = [
  /failed to download/i,
  /no such host/i,
  /could not resolve/i,
  /network is unreachable/i,
];

/**
 * Classe un échec de limactl.
 * @param stderr - Sortie d'erreur (journal JSON ou texte).
 * @param action - Action tentée, pour le message (« démarrer la VM »).
 */
export function classifyLimaFailure(stderr: string, action: string): AtelierError {
  const detail = lastLimaError(stderr) ?? stderr.trim().split('\n').slice(-3).join(' | ');
  const details = { action, detail: detail.slice(0, 2000) };
  if (DISK_PATTERNS.some((p) => p.test(stderr))) {
    return new AtelierError(
      'sandbox/disk_full',
      `Disque plein : impossible de ${action}. Libérez de l'espace sur le Mac (au moins 10 Go) puis réessayez.`,
      { details },
    );
  }
  if (VIRTUALIZATION_PATTERNS.some((p) => p.test(stderr))) {
    return new AtelierError(
      'sandbox/virtualization_unavailable',
      `La virtualisation n'est pas disponible sur ce Mac : impossible de ${action}. Un Mac Apple Silicon sous macOS 14 ou plus est requis (pas de VM imbriquée).`,
      { details },
    );
  }
  if (DOWNLOAD_PATTERNS.some((p) => p.test(stderr))) {
    return new AtelierError(
      'sandbox/failed',
      `Téléchargement impossible pendant l'opération « ${action} ». Vérifiez la connexion internet puis réessayez.`,
      { retryable: true, details },
    );
  }
  if (TIMEOUT_PATTERNS.some((p) => p.test(stderr))) {
    return new AtelierError(
      'sandbox/timeout',
      `Délai dépassé : impossible de ${action}. Réessayez ; si le problème persiste, réinitialisez la VM dans les Réglages.`,
      { retryable: true, details },
    );
  }
  return new AtelierError(
    'sandbox/failed',
    `Impossible de ${action} : ${detail || 'erreur inconnue'}`,
    {
      details,
    },
  );
}
