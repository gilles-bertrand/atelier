import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'voice',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
