import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/bin.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: false,
  // The build script first moves the previous dist to Trash; tsup must not delete it.
  clean: false,
  splitting: true,
  target: 'node20',
});
