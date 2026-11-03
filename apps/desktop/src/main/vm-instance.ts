/**
 * VM de cette instance de l'app (ticket #41).
 *
 * - App normale (sans `--user-data-dir`) : l'instance Lima `atelier`, comme avant.
 * - Instance de test (`--user-data-dir` imposé : e2e, QA, mesures, app packagée
 *   pilotée) : PAS de VM par défaut. `ATELIER_VM_INSTANCE=atelier-<nom>` en
 *   demande une dédiée, créée au besoin dans le même LIMA_HOME et réutilisée
 *   d'un lancement à l'autre (`atelier-e2e` pour les e2e réels).
 *
 * Une instance de test ne démarre, ne remonte, n'arrête ni ne supprime donc
 * jamais la VM `atelier` de la session principale : ce nom lui est refusé.
 * La variable n'est lue qu'avec `--user-data-dir`.
 */
import { DEFAULT_INSTANCE_NAME, isInstanceName } from '@atelier/sandbox';

/** Variable d'environnement qui demande une VM dédiée pour une instance de test. */
export const VM_INSTANCE_ENV = 'ATELIER_VM_INSTANCE';

/** Préfixe imposé aux VM dédiées : `limactl list` les range à côté d'`atelier`. */
export const DEDICATED_VM_PREFIX = `${DEFAULT_INSTANCE_NAME}-`;

/** VM à piloter, ou aucune (la raison s'affiche dans l'état « Indisponible »). */
export type VmChoice =
  { kind: 'lima'; instanceName: string } | { kind: 'disabled'; reason: string };

export function chooseVm(options: {
  /** `app.commandLine.hasSwitch('user-data-dir')`. */
  userDataDirImposed: boolean;
  /** Valeur de `ATELIER_VM_INSTANCE`. */
  requested: string | undefined;
}): VmChoice {
  if (!options.userDataDirImposed) return { kind: 'lima', instanceName: DEFAULT_INSTANCE_NAME };
  const requested = options.requested?.trim() ?? '';
  if (requested === '') {
    return {
      kind: 'disabled',
      reason: `VM désactivée pour une instance de test (--user-data-dir). Pour une VM dédiée, lancez-la avec ${VM_INSTANCE_ENV}=atelier-e2e.`,
    };
  }
  if (requested === DEFAULT_INSTANCE_NAME) {
    return {
      kind: 'disabled',
      reason: `${VM_INSTANCE_ENV}=${DEFAULT_INSTANCE_NAME} refusé : c'est la VM de la session principale. Choisissez une VM dédiée, par exemple atelier-e2e.`,
    };
  }
  if (!requested.startsWith(DEDICATED_VM_PREFIX) || !isInstanceName(requested)) {
    return {
      kind: 'disabled',
      reason: `${VM_INSTANCE_ENV} invalide (« ${requested} ») : attendu « ${DEDICATED_VM_PREFIX} » suivi de minuscules, de chiffres et de tirets, par exemple atelier-e2e.`,
    };
  }
  return { kind: 'lima', instanceName: requested };
}
