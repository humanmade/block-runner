import { defineConfig } from 'vitest/config';

/** Development compatibility observations, separate from release acceptance. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['dev/test/proof-gutenberg-compat.test.ts'],
    fileParallelism: false,
    testTimeout: 1_800_000,
  },
});
