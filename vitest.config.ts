import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/*.test.ts'], // top-level only; fixtures under test/fixtures are not test suites
  },
});
