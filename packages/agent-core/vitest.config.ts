import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'agent-core',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
