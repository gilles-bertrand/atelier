import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'mcp-bridge',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
