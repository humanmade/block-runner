import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'dev/test/plugin.consumer.test.ts',
      'dev/test/proof-native-style-adapter-builder.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
