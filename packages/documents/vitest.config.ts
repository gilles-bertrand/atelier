import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'documents',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
