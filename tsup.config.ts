import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/bin.ts' },
  format: ['esm'],
  // TypeScript 7 emits declarations separately; tsup's DTS bundler needs the old compiler API.
  dts: false,
  sourcemap: false,
  // The build script first moves the previous dist to Trash; tsup must not delete it.
  clean: false,
  splitting: true,
  target: 'node22',
});
