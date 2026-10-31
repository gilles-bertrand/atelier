import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'shared',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Fuseau fixe : les récurrences (schedule.ts) se calculent en heure locale,
    // changements d'heure compris.
    env: { TZ: 'Europe/Paris' },
  },
});
