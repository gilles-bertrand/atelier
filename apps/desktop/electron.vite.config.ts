import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Les packages @atelier/* sont consommés en source TypeScript : on les bundle
 * (exclus de l'externalisation) au lieu de les laisser en `require` runtime.
 */
const bundledWorkspacePackages = [
  '@atelier/shared',
  '@atelier/agent-core',
  '@atelier/sandbox',
  '@atelier/skills',
  '@atelier/mcp-bridge',
  '@atelier/web',
  '@atelier/documents',
];

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: bundledWorkspacePackages } },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: bundledWorkspacePackages },
      rollupOptions: {
        // Preload en `sandbox: true` : CommonJS obligatoire.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve(import.meta.dirname, 'src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
  },
});
