import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each file boots a full headless Gutenberg runtime. Parallel boots contend heavily enough
    // to cross the timeout together on developer machines, so serialize files for a stable gate.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
