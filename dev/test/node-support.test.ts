import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planStandalonePluginOutput } from '../../src/plugin/profile.js';
import { assertSupportedNodeVersion, isSupportedNodeVersion, SUPPORTED_NODE_RANGE } from '../../src/node-support.js';

const floors = ['22.23.4', '24.22.1', '26.12.1'];
const GENERATED_PLUGIN_NODE_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1';

describe('Node support contract', () => {
  it('accepts each supported floor and rejects the gaps and lower patches', () => {
    for (const version of floors) expect(isSupportedNodeVersion(version)).toBe(true);
    for (const version of ['20.19.0', '21.0.0', '22.23.3', '23.0.0', '24.22.0', '25.0.0', '26.12.0']) {
      expect(isSupportedNodeVersion(version)).toBe(false);
    }
  });

  it('explains an unsupported runtime before the CLI can claim success', () => {
    expect(() => assertSupportedNodeVersion('23.0.0')).toThrow(
      `block-runner requires Node.js ${SUPPORTED_NODE_RANGE}; found v23.0.0.`,
    );
  });

  it('retains runtime site APIs on the guarded library entry point', async () => {
    const library = await import('../../src/index.js');
    for (const name of [
      'planSite', 'inspectSiteDrift', 'confirmSitePull', 'previewSitePull',
      'readSiteSnapshot', 'readSiteTemplateSnapshot', 'prepareSiteSource',
      'compileSite', 'compileThemeDocuments', 'writeCompiledSite', 'applySite',
    ] as const) {
      expect(library[name], name).toBeTypeOf('function');
    }
    expect(library.SitePullPublicationError).toBeTypeOf('function');
    expect(library.SiteWriteError).toBeTypeOf('function');
  });

  it('keeps package, documentation, skill, and CI declarations aligned', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const skill = await readFile(new URL('../../skills/block-runner/SKILL.md', import.meta.url), 'utf8');
    const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

    expect(packageJson.engines.node).toBe(SUPPORTED_NODE_RANGE);
    expect(readme).toContain(`Node.js ${SUPPORTED_NODE_RANGE}`);
    expect(skill).toContain(`compatibility: Requires Node.js ${SUPPORTED_NODE_RANGE}`);
    expect(ci).toContain(SUPPORTED_NODE_RANGE);
    expect(ci).toContain('node: [22.23.4, 24.22.1, 26.12.1]');
    expect(ci).toContain('npm ci --engine-strict');
    expect(ci).toContain('npm run smoke:package');
  });

  it('keeps the generated plugin build engine contract independent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-node-support-'));
    const plan = await planStandalonePluginOutput(path.join(root, 'notice-plugin'), {
      name: 'acme/notice',
      files: { 'block.json': JSON.stringify({ name: 'acme/notice' }) },
    });
    const packageJson = plan.touchedFiles.find((file) => file.relativePath === 'package.json')!.content.toString();
    const lockfile = plan.touchedFiles.find((file) => file.relativePath === 'package-lock.json')!.content.toString();

    expect(JSON.parse(packageJson).engines.node).toBe(GENERATED_PLUGIN_NODE_RANGE);
    expect(JSON.parse(lockfile).packages[''].engines.node).toBe(GENERATED_PLUGIN_NODE_RANGE);
  });
});
