import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'dev/test/authoring-benchmark.test.ts',
      'dev/test/authoring.receipts.test.ts',
      'dev/test/authoring.runner.test.ts',
      'dev/test/authoring.style-ledger.test.ts',
      'dev/test/benchmark.test.ts',
      'dev/test/engine-skill.test.ts',
      'dev/test/project-owned-blocks.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
