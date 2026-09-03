import { defineConfig } from 'vitest/config';

/** The explicit, Docker-backed WordPress 7.1 acceptance receipt. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/proof-real-wordpress.test.ts'],
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 60_000,
  },
});
