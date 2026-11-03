/**
 * Dossier de données de l'app (historique, réglages, secrets).
 *
 * `Application Support/@atelier/desktop`, tiré du `name` du package.json, en
 * dev comme packagé. Il est épinglé pour que le renommage en YodAI
 * (`app.setName`) ne le déplace pas. Ce n'est PAS `Application Support/Atelier`,
 * qui ne contient que la VM (`lima/`).
 *
 * Un `--user-data-dir` passé en ligne de commande l'emporte : e2e (`qa/e2e`),
 * instances de mesure ou de QA, qui ne doivent jamais toucher aux données ni au
 * verrou d'instance unique de l'utilisateur, ni à sa VM (voir `vm-instance.ts`).
 */
import { join } from 'node:path';

/**
 * Dossier à imposer avec `app.setPath('userData', …)`, ou `undefined` pour
 * garder celui de la ligne de commande.
 * @param appData - `app.getPath('appData')`.
 * @param hasUserDataDirSwitch - `app.commandLine.hasSwitch('user-data-dir')`.
 */
export function pinnedUserDataDir(
  appData: string,
  hasUserDataDirSwitch: boolean,
): string | undefined {
  return hasUserDataDirSwitch ? undefined : join(appData, '@atelier', 'desktop');
}
