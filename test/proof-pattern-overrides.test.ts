import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { portableFixturePlan } from '../scripts/build-pattern-overrides-fixture.js';
import { compileRegisteredBlock } from '../src/authoring/generate.js';
import { validatePatternOverrideContract } from '../src/authoring/pattern-overrides.js';
import { hashAuthoringPlan, type AuthoringPlan } from '../src/authoring/schema.js';
import { runProof } from '../src/index.js';

describe('pattern-override receipts', () => {
  it('keeps retained fixture input hashes stable across temporary proof roots', () => {
    const planForRoot = (root: string): AuthoringPlan => ({
      version: 1,
      generatorVersion: '0.9.0',
      target: { name: 'acme/pattern', title: 'Pattern' },
      structure: [],
      fields: [],
      locking: { mode: 'contentOnly' },
      styles: { strategy: 'native', outcomes: [] },
      pattern: { ready: false, overrides: [] },
      assets: [
        {
          id: 'canonical-image',
          source: path.join(root, 'source', 'canonical.png'),
          status: 'ready',
          destination: 'assets/canonical.png',
          sha256: 'a'.repeat(64),
          uses: [{ node: 'hero.image', attribute: 'url' }],
        },
        {
          id: 'static-logo',
          source: path.join(root, 'source', 'logo.svg'),
          status: 'ready',
          destination: 'assets/logo.svg',
          sha256: 'b'.repeat(64),
          uses: [{ node: 'hero.logo', attribute: 'url' }],
        },
      ],
      files: [],
      warnings: [],
    });

    const first = portableFixturePlan(planForRoot('/private/tmp/proof-one'));
    const second = portableFixturePlan(planForRoot('/private/tmp/proof-two'));
    expect(first.assets.map(({ source }) => source)).toEqual(['source/canonical.png', 'source/logo.svg']);
    expect(second).toEqual(first);
    expect(hashAuthoringPlan(second)).toBe(hashAuthoringPlan(first));
  });

  it('serializes wp-env invocations so concurrent config writers cannot erase its runtime cache', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-serial-'));
    const inputPath = path.join(root, 'input.json');
    const pluginZip = path.join(root, 'fixture.zip');
    await Promise.all([writeFile(inputPath, '{}'), writeFile(pluginZip, 'adapter-only fixture')]);
    let active = 0;
    let peak = 0;
    let observations = 0;
    await runProof({
      profile: 'runtime', inputPath, pluginZip, outputDir: root,
      fixture: { blockName: 'acme/serial' },
      commandRunner: async (command, args) => {
        if (args.includes('wp-env')) {
          active++;
          peak = Math.max(peak, active);
          if (args.includes('run')) observations++;
          await new Promise((resolve) => setTimeout(resolve, 2));
          active--;
        }
        return { command, args: [...args], exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(observations).toBeGreaterThanOrEqual(8);
    expect(peak).toBe(1);
  });

  it('compiles the canonical CLI fixture with exactly its ten confirmed native fields', async () => {
    const plan = JSON.parse(await readFile('test/fixtures/authoring/pattern-overrides.plan.json', 'utf8'));
    const first = compileRegisteredBlock(plan);
    expect(compileRegisteredBlock(plan)).toEqual(first);
    const contract = validatePatternOverrideContract(first.template, []);
    expect(contract.ok).toBe(true);
    expect(contract.bindings).toHaveLength(10);
    expect(new Set(contract.bindings.map(({ name }) => name)).size).toBe(3);
    const edit = first.files.find(({ path }) => path === 'edit.js')!.content;
    expect(edit).toContain('core/pattern-overrides');
    expect(edit).toContain('contentOnly');
    expect(edit).toContain('Canonical layout version one.');
    // No handmade runtime bundle or pretend ZIP. The explicit WordPress
    // acceptance test builds and installs this compiler's actual source.
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
      status: 'blocked',
      record: expect.objectContaining({
        details: expect.objectContaining({
          unobserved: expect.arrayContaining(['wordpress.coreSource']),
        }),
      }),
    }));
  });
});
