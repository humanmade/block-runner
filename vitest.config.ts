import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The Docker/wp-env lifecycle is a separately invoked acceptance command.
    // `npm test` stays a fast repository check even on machines without Docker.
    exclude: ['test/proof-real-wordpress.test.ts'],
    // Each file boots a full headless Gutenberg runtime. Parallel boots contend heavily enough
    // to cross the timeout together on developer machines, so serialize files for a stable gate.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
