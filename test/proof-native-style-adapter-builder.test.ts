import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNativeStyleAdapterProofFixture } from '../scripts/build-pattern-overrides-fixture.js';

describe('native style adapter proof fixture', () => {
  it('refuses a public utility hero when pinned Core Image would override authored image sizing', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'block-runner-native-style-adapter-builder-'));
    await expect(buildNativeStyleAdapterProofFixture(outputDir)).rejects.toThrow(/pinned core\/image serialization/);
    expect(existsSync(path.join(outputDir, 'native-style-adapter.original.html'))).toBe(true);
    await expect(readFile(path.join(outputDir, 'native-style-adapter.original.html'), 'utf8')).resolves.toContain('Build a WordPress block');
    await expect(readFile(path.join(outputDir, 'native-style-adapter.supplied.css'), 'utf8')).resolves.toContain('.focus-visible\\:outline:focus-visible');
    await expect(readFile(path.join(outputDir, 'native-style-adapter.proposal.json'), 'utf8')).resolves.toContain('core/image');
  }, 360_000);
});
