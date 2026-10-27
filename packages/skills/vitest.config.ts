import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'skills',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
