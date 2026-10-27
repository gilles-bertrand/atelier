import { defineConfig } from 'vitest/config';

/**
 * Configuration Vitest racine : chaque package/app est un « projet ».
 * `pnpm test` exécute l'ensemble ; `pnpm --filter <pkg> test` cible un package.
 */
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
  },
});
