/**
 * Emplacements des ressources embarquées, en développement et une fois packagé.
 *
 * Packagé : `Contents/Resources/{lima,lima-templates,skills-examples}`
 * (voir `electron-builder.yml`). En dev : le dépôt.
 */
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

export interface AppPaths {
  limactl: string;
  limaTemplates: string;
  skillsExamples: string;
  userData: string;
}

export function resolveAppPaths(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  userData: string;
}): AppPaths {
  if (options.isPackaged) {
    return {
      limactl: join(options.resourcesPath, 'lima', 'bin', 'limactl'),
      limaTemplates: join(options.resourcesPath, 'lima-templates'),
      skillsExamples: join(options.resourcesPath, 'skills-examples'),
      userData: options.userData,
    };
  }
  // `appPath` = apps/desktop en développement.
  return {
    limactl: join(options.appPath, 'resources', 'lima', 'bin', 'limactl'),
    limaTemplates: join(options.appPath, '..', '..', 'lima'),
    skillsExamples: join(options.appPath, '..', '..', 'packages', 'skills', 'examples'),
    userData: options.userData,
  };
}

/** Message clair si le moteur de VM n'est pas livré (dev sans `pnpm fetch:lima`). */
export async function limaPreflight(
  paths: AppPaths,
  isPackaged: boolean,
): Promise<string | undefined> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return 'La VM nécessite un Mac Apple Silicon.';
  }
  try {
    await access(paths.limactl, constants.X_OK);
    return undefined;
  } catch {
    return isPackaged
      ? 'Le moteur de la VM est absent de l’application. Réinstallez Atelier.'
      : 'Moteur de VM absent : lancez « pnpm fetch:lima » puis relancez l’app.';
  }
}
