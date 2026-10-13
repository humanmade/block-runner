import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['dev/test/**/*.test.ts'],
    // The Docker/wp-env lifecycle is a separately invoked acceptance command.
    // `npm test` stays a fast repository check even on machines without Docker.
    exclude: [
      'dev/test/proof-real-wordpress.test.ts',
      'dev/test/proof-query-wordpress.test.ts',
      'dev/test/proof-tabs-wordpress.test.ts',
      'dev/test/proof-gutenberg-compat.test.ts',
      'dev/test/plugin.consumer.test.ts',
      'dev/test/proof-native-style-adapter-builder.test.ts',
      // Benchmark and repository tooling under scripts/ runs with `npm run test:tools`.
      'dev/test/authoring-benchmark.test.ts',
      'dev/test/authoring.receipts.test.ts',
      'dev/test/authoring.runner.test.ts',
      'dev/test/authoring.style-ledger.test.ts',
      'dev/test/benchmark.test.ts',
      'dev/test/engine-skill.test.ts',
      'dev/test/project-owned-blocks.test.ts',
    ],
    // Each file boots a full headless Gutenberg runtime. Parallel boots contend heavily enough
    // to cross the timeout together on developer machines, so serialize files for a stable gate.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
