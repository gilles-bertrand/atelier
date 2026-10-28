import { resolve } from 'node:path';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: { '@renderer': resolve(import.meta.dirname, 'src/renderer/src') },
  },
  test: {
    name: 'desktop',
    // Main et code commun : Node. Composants : `// @vitest-environment jsdom` en tête de fichier.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/renderer/src/test/setup.ts'],
  },
});
