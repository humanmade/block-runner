import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: false,
  // The build script first moves the previous dist to Trash; tsup must not delete it.
  clean: false,
  splitting: false,
  target: 'node20',
});
