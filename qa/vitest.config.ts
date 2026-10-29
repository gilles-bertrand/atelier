import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'qa',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
