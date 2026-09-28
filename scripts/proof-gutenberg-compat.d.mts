import type { buildPatternOverridesFixture } from './build-pattern-overrides-fixture.js';
import type { WpBlock } from '../src/types.js';

export function proveGutenbergCompatibility(options: {
  root: string;
  outputDir: string;
  built: Awaited<ReturnType<typeof buildPatternOverridesFixture>>;
  expectedTree: WpBlock[];
  imageBase64: string;
}): Promise<{ status: string; lanes: Array<{ name: string; status: string; error?: string }> }>;
