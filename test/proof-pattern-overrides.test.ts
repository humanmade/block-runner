import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPatternOverridesFixture } from '../scripts/build-pattern-overrides-fixture.js';
import { runProof } from '../src/index.js';

describe('pattern-override receipts', () => {
  it('builds a deterministic generated plugin and uses its markup inside both synced-pattern versions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-pattern-fixture-'));
    const secondRoot = await mkdtemp(path.join(tmpdir(), 'block-runner-pattern-fixture-'));
    const built = await buildPatternOverridesFixture(root);
    const second = await buildPatternOverridesFixture(secondRoot);
    const pattern = built.fixture.patternOverrides!;
    const browserSource = await readFile(path.join(built.pluginDirectory, 'build', 'index.js'), 'utf8');
    const generatedTemplate = await readFile(path.join(built.pluginDirectory, 'generated-source', 'template.js'), 'utf8');

    expect(pattern.instances).toHaveLength(2);
    expect(pattern.instances[0]!.content).not.toEqual(pattern.instances[1]!.content);
    expect(pattern.canonicalContent).toContain(`<!-- wp:${built.fixture.blockName}`);
    expect(pattern.canonicalUpdate.content).toContain(`<!-- wp:${built.fixture.blockName}`);
    expect(pattern.canonicalContent).toContain(built.nativeContainerMarkup);
    expect(pattern.canonicalContent).toContain('core/pattern-overrides');
    expect(pattern.canonicalContent).not.toContain('"innerBlocks"');
    expect(pattern.requiredBindings).toHaveLength(6);
    expect(browserSource).toContain('useInnerBlocksProps');
    expect(browserSource).toContain('core/pattern-overrides');
    expect(generatedTemplate).toContain('core/pattern-overrides');
    await expect(readFile(built.pluginZip)).resolves.toEqual(await readFile(second.pluginZip));
    expect(pattern.negative).toMatchObject({
      value: expect.any(String),
      fallback: expect.any(String),
    });
    expect(built.nativeContainerMarkup).toContain('wp-block-group block-runner-pattern-layout has-background');
    expect(built.nativeContainerMarkup).toContain('style="background-color:#dcecff"');
    expect(pattern.canonicalUpdate.content).toContain('block-runner-layout-v2 has-background');
    expect(built.fixture.visual).toMatchObject({
      expectedPath: expect.any(String),
      threshold: expect.any(Number),
    });
    expect(built.fixture.visual?.expectedPath).toBe(path.resolve('proof/wordpress-7.1-pattern-overrides.expected.png'));
    expect(existsSync(built.fixture.visual!.expectedPath)).toBe(true);
    expect(createHash('sha256').update(await readFile(built.fixture.visual!.expectedPath)).digest('hex'))
      .toBe('28ba963d8c728c462f81c9123c67b7d8644aa33eaa202cc37a8df10a95cb1bcd');
  });

  it('retains explicitly supplied headless adapter evidence in a headless receipt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-pattern-receipt-'));
    const input = path.join(root, 'plan.json');
    await writeFile(input, '{"plan":"pattern"}');

    const result = await runProof({
      profile: 'headless',
      inputPath: input,
      outputDir: root,
      gateRunner: async () => ({
        status: 'pass',
        details: {
          canonicalWpBlockContent: '<!-- wp:group -->canonical<!-- /wp:group -->',
          coreBlockContent: [
            { ref: 1, content: { 'hero.title': { content: 'First' } } },
            { ref: 1, content: { 'hero.title': { content: 'Second' } } },
          ],
        },
      }),
    });

    expect(result.ok).toBe(true);
    // This is a receipt-format unit test only. The full real-WordPress receipt
    // is exercised without an adapter in proof-real-wordpress.test.ts.
    expect(result.receipt.environment.wordpress.requestedVersion).toBe('7.1');
    expect(result.receipt.gates[0]).toMatchObject({
      gate: 'headless_validation',
      details: {
        canonicalWpBlockContent: expect.stringContaining('canonical'),
      },
    });
    expect(JSON.parse(await readFile(path.join(root, result.receiptReference.path), 'utf8'))).toEqual(result.receipt);
  });

  it('does not give a false pass when the required pattern support is absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-pattern-negative-'));
    const input = path.join(root, 'plan.json');
    const plugin = path.join(root, 'fixture.zip');
    await Promise.all([writeFile(input, '{"plan":"pattern"}'), writeFile(plugin, 'fixture')]);

    const result = await runProof({
      profile: 'full',
      inputPath: input,
      pluginZip: plugin,
      outputDir: root,
      fixture: {
        blockName: 'acme/pattern',
        editableFields: [{ path: 'content', surface: 'richText' }],
        frontend: { url: 'http://example.test/' },
        visual: { expectedPath: 'fixture.png', threshold: 0 },
        accessibility: { manualReview: 'pass' },
      },
      gateRunner: async () => ({ status: 'pass' }),
    });

    expect(result.ok).toBe(false);
    expect(result.profile.failedGates).toContainEqual(expect.objectContaining({
      gate: 'pattern_overrides',
      status: 'blocked',
    }));
  });

  it('does not let a Core-only pattern pass as generated-block evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-core-only-pattern-'));
    const input = path.join(root, 'plan.json');
    const plugin = path.join(root, 'fixture.zip');
    await Promise.all([writeFile(input, '{"plan":"pattern"}'), writeFile(plugin, 'fixture')]);
    const coreOnly = '<!-- wp:heading {"metadata":{"name":"hero-title","bindings":{"content":{"source":"core/pattern-overrides"}}}} --><h2>Canonical heading</h2><!-- /wp:heading -->';

    const result = await runProof({
      profile: 'full',
      inputPath: input,
      pluginZip: plugin,
      outputDir: root,
      fixture: {
        blockName: 'acme/generated-wrapper',
        editableFields: [{ path: 'content', surface: 'richText' }],
        frontend: { url: 'http://example.test/' },
        visual: { expectedPath: 'fixture.png', threshold: 0 },
        accessibility: { manualReview: 'pass' },
        patternOverrides: {
          title: 'Core-only counterexample',
          canonicalContent: coreOnly,
          instances: [
            { label: 'first', content: { 'hero-title': { content: 'First' } } },
            { label: 'second', content: { 'hero-title': { content: 'Second' } } },
          ],
          canonicalUpdate: { marker: 'Updated', content: coreOnly },
          reset: { instance: 0, name: 'hero-title', attribute: 'content', fallback: 'Canonical heading' },
          requiredBindings: [{ name: 'hero-title', attribute: 'content' }],
          structuralPolicy: 'contentOnly',
          negative: { name: 'hero-title', attribute: 'content', value: 'Rejected', fallback: 'Canonical heading' },
        },
      },
      gateRunner: async () => ({ status: 'pass' }),
    });

    expect(result.ok).toBe(false);
    expect(result.profile.failedGates).toContainEqual(expect.objectContaining({
      gate: 'pattern_overrides',
      status: 'blocked',
    }));
  });

  it('rejects a runtime whose observed version is 7.1 but whose configured core source is not', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-wp-source-'));
    const input = path.join(root, 'plan.json');
    const plugin = path.join(root, 'fixture.zip');
    const config = path.join(root, 'wp-env.json');
    await Promise.all([
      writeFile(input, '{"plan":"pattern"}'),
      writeFile(plugin, 'fixture'),
      writeFile(config, '{"core":"WordPress/WordPress#7.0"}'),
    ]);

    const result = await runProof({
      profile: 'runtime',
      inputPath: input,
      pluginZip: plugin,
      markup: '<!-- wp:paragraph --><p>Proof</p><!-- /wp:paragraph -->',
      outputDir: root,
      wpEnvConfig: config,
      fixture: { blockName: 'acme/pattern' },
      commandRunner: async (command, args) => {
        const joined = args.join(' ');
        const response = (stdout = '') => ({ command, args: [...args], exitCode: 0, stdout, stderr: '' });
        if (args.some((argument) => argument.endsWith('proof-playwright.mjs'))) {
          const output = args[args.indexOf('--out') + 1]!;
          await writeFile(output, JSON.stringify({
            gates: { client_registry: { status: 'pass' } },
            environment: { browser: { version: '123.0', revision: '123' } },
          }));
          return response();
        }
        if (command === 'docker') return response('abcdef123456 image-id wordpress:latest');
        if (joined.includes('php -r')) return response('8.3.0');
        if (joined.includes('db query')) return response('8.0.36');
        if (joined.includes('theme list')) return response('[{"name":"Twenty Twenty-Six","version":"1.0"}]');
        if (joined.includes("hash_file('sha256', get_stylesheet_directory()")) return response('theme-hash');
        if (joined.includes('core version')) return response('7.1');
        if (joined.includes("hash_file('sha256', ABSPATH")) return response('core-hash');
        if (joined.includes('run wordpress sh')) return response('abcdef123456');
        if (joined.includes('run mysql sh')) return response('abcdef123456');
        if (joined.includes('plugin get')) return response('{"name":"Fixture","version":"1.0.0","plugin":"pattern/pattern.php"}');
        if (joined.includes('is_registered')) return response('registered');
        if (joined.includes('rest_do_request')) return response('200');
        return response();
      },
    });

    expect(result.receipt.environment.wordpress).toMatchObject({
      coreSource: 'WordPress/WordPress#7.0',
      version: '7.1',
    });
    expect(result.profile.failedGates).toContainEqual(expect.objectContaining({
      gate: 'environment_observation',
      status: 'fail',
      record: expect.objectContaining({
        details: expect.objectContaining({
          configuredCoreSource: 'WordPress/WordPress#7.0',
        }),
      }),
    }));
  });
});
