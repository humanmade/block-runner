import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planStandalonePluginOutput } from '../src/plugin/profile.js';
import { assertSupportedNodeVersion, isSupportedNodeVersion, SUPPORTED_NODE_RANGE } from '../src/node-support.js';

const floors = ['20.19.0', '22.13.0', '24.0.0'];

describe('Node support contract', () => {
  it('accepts each supported floor and rejects the gaps and lower patches', () => {
    for (const version of floors) expect(isSupportedNodeVersion(version)).toBe(true);
    for (const version of ['20.18.1', '20.19.0-pre.1', '21.0.0', '22.12.0', '23.0.0']) {
      expect(isSupportedNodeVersion(version)).toBe(false);
    }
  });

  it('explains an unsupported runtime before the CLI can claim success', () => {
    expect(() => assertSupportedNodeVersion('23.0.0')).toThrow(
      `block-runner requires Node.js ${SUPPORTED_NODE_RANGE}; found v23.0.0.`,
    );
  });

  it('keeps package, documentation, skill, and CI declarations aligned', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const skill = await readFile(new URL('../skills/block-runner/SKILL.md', import.meta.url), 'utf8');
    const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

    expect(packageJson.engines.node).toBe(SUPPORTED_NODE_RANGE);
    expect(readme).toContain(`Node.js ${SUPPORTED_NODE_RANGE}`);
    expect(skill).toContain(`compatibility: Requires Node.js ${SUPPORTED_NODE_RANGE}`);
    expect(ci).toContain(SUPPORTED_NODE_RANGE);
    expect(ci).toContain('node: [20.19.0, 22.13.0, 24.0.0]');
    expect(ci).toContain('npm ci --engine-strict');
    expect(ci).toContain('npm run smoke:package');
  });

  it('emits the same Node range in generated standalone plugin metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-node-support-'));
    const plan = await planStandalonePluginOutput(path.join(root, 'notice-plugin'), {
      name: 'acme/notice',
      files: { 'block.json': JSON.stringify({ name: 'acme/notice' }) },
    });
    const packageJson = plan.touchedFiles.find((file) => file.relativePath === 'package.json')!.content.toString();
    const lockfile = plan.touchedFiles.find((file) => file.relativePath === 'package-lock.json')!.content.toString();

    expect(JSON.parse(packageJson).engines.node).toBe(SUPPORTED_NODE_RANGE);
    expect(JSON.parse(lockfile).packages[''].engines.node).toBe(SUPPORTED_NODE_RANGE);
  });
});
