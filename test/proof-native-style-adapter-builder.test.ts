import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNativeStyleAdapterProofFixture } from '../scripts/build-pattern-overrides-fixture.js';

describe('native style adapter proof fixture', () => {
  it('retains and pins the public utility hero package with authored image sizing', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'block-runner-native-style-adapter-builder-'));
    const built = await buildNativeStyleAdapterProofFixture(outputDir);
    expect(existsSync(built.pluginZip)).toBe(true);
    expect(built.fixture.nativeStyleAdapterMatrix).toBeDefined();
    expect(existsSync(path.join(outputDir, 'native-style-adapter.original.html'))).toBe(true);
    await expect(readFile(path.join(outputDir, 'native-style-adapter.original.html'), 'utf8')).resolves.toContain('Build a WordPress block');
    await expect(readFile(path.join(outputDir, 'native-style-adapter.supplied.css'), 'utf8')).resolves.toContain('.focus-visible\\:outline:focus-visible');
    await expect(readFile(path.join(outputDir, 'native-style-adapter.supplied.css'), 'utf8')).resolves.toContain('width: 100%');
    await expect(readFile(path.join(outputDir, 'native-style-adapter.proposal.json'), 'utf8')).resolves.toContain('core/image');
    await expect(readFile(path.join(outputDir, 'native-style-adapter.canonical-plan.json'), 'utf8')).resolves.toContain('native-adapter-target');
    await expect(readFile(path.join(outputDir, 'native-style-adapter.native.blocks.html'), 'utf8')).resolves.toContain('wp-block-button__link');
    await expect(readFile(path.join(outputDir, 'native-style-adapter.plugin-identity.json'), 'utf8')).resolves.toContain(built.artifact.sha256);
    const manifest = JSON.parse(await readFile(built.inputPath, 'utf8')) as { inputs?: Record<string, string> };
    expect(Object.keys(manifest.inputs ?? {}).sort()).toEqual([
      'native-style-adapter.canonical-plan.json',
      'native-style-adapter.native.blocks.html',
      'native-style-adapter.original.html',
      'native-style-adapter.plugin-identity.json',
      'native-style-adapter.proposal.json',
      'native-style-adapter.supplied.css',
      path.basename(built.pluginZip),
    ].sort());
    expect(Object.values(manifest.inputs ?? {}).every((value) => /^sha256:[a-f0-9]{64}$/.test(value))).toBe(true);
  }, 360_000);
});
