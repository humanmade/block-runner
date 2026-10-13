import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareThemeMarkup,
  effectiveWpEnvConfig,
  effectiveWpEnvPort,
  effectiveWpEnvUrl,
  pinLocalPluginDirectories,
  removeThemeAttributes,
  writeThemeRuntimeConfig,
} from '../../src/proof/theme.js';

// @ts-expect-error The packaged browser helper exposes a small runtime-check seam for this test.
const { runAfterRuntimeVerification, proveFile } = await import('../../scripts/proof-theme-playwright.mjs') as {
  runAfterRuntimeVerification: (settings: unknown, marker: string, action: () => Promise<void>) => Promise<boolean>;
  proveFile: (page: unknown, theme: string, file: { file: string; kind: 'template' | 'part' }, baseUrl: string) => Promise<Record<string, any>>;
};
import { PROOF_PROFILES } from '../../src/proof/profiles.js';
import { runProof } from '../../src/proof/runner.js';
import { EvidenceStore } from '../../src/proof/receipt.js';

describe('theme Site Editor proof profile', () => {
  it('requires activation, real round-trip, environment observations, and PHP logs', () => {
    expect(PROOF_PROFILES.theme.requiredGates).toEqual([
      'theme_activation', 'theme_roundtrip', 'environment_observation', 'php_logs',
    ]);
    expect(PROOF_PROFILES.runtime.requiredGates).toContain('zip_installation');
  });

  it('removes only a matching top-level theme attribute from template-part comments', () => {
    expect(removeThemeAttributes(
      '<!-- wp:template-part {"slug":"header","theme":"fixture","area":"header"} /-->',
      'fixture',
    )).toBe('<!-- wp:template-part {"slug":"header","area":"header"} /-->');
    expect(removeThemeAttributes(
      '<!-- wp:template-part {"slug":"header","theme":"other"} /--><!-- wp:group {"theme":"fixture"} /-->',
      'fixture',
    )).toBe('<!-- wp:template-part {"slug":"header","theme":"other"} /--><!-- wp:group {"theme":"fixture"} /-->');
  });

  it('reports the first differing UTF-8 byte without whitespace normalization', () => {
    const result = compareThemeMarkup('<p>café</p>', '<p>cafe</p>', 'fixture');
    expect(result.equal).toBe(false);
    expect(result.firstDifferenceByte).toBe(6);
    expect(compareThemeMarkup('<!-- wp:template-part {"theme":"fixture"} /-->', '<!-- wp:template-part {} /-->', 'fixture').equal).toBe(true);
    expect(compareThemeMarkup('a\n', 'a \n', 'fixture').firstDifferenceByte).toBe(1);
  });

  it('resolves the effective local wp-env URL and rejects ambiguous auto-port settings', () => {
    expect(effectiveWpEnvPort({ env: { development: { port: 8892 } } }, {})).toBe(8892);
    expect(effectiveWpEnvPort({ port: 8891, env: { development: { port: 8892 } } }, {})).toBe(8892);
    expect(effectiveWpEnvPort({ port: 8891, env: { development: { port: 8892 } } }, { WP_ENV_PORT: '8893' })).toBe(8893);
    expect(effectiveWpEnvUrl({ port: 8891 }, {})).toBe('http://localhost:8891');
    expect(effectiveWpEnvUrl({ config: { WP_HOME: 'http://localhost' }, env: { development: { port: 8892 } } }, {})).toBe('http://localhost:8892');
    expect(() => effectiveWpEnvUrl({ autoPort: true, port: 8891 }, {})).toThrow(/autoPort/);
    expect(() => effectiveWpEnvUrl({ config: { WP_HOME: 'https://example.com' } }, {})).toThrow(/local HTTP host/);
  });

  it('does not attempt a template save when the authenticated runtime marker mismatches', async () => {
    let writes = 0;
    const verified = await runAfterRuntimeVerification(
      { description: 'another wp-env site' },
      'this-run-marker',
      async () => { writes++; },
    );
    expect(verified).toBe(false);
    expect(writes).toBe(0);
  });

  it('ignores development overrides and stages root dependencies when testsEnvironment is false', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-single-env-'));
    const config = {
      testsEnvironment: false,
      port: 8891,
      core: 'WordPress/WordPress#7.1',
      phpVersion: '8.4',
      plugins: ['./plugins/root-helper'],
      themes: ['./themes/root-theme'],
      mappings: { 'wp-content/uploads': './root-uploads' },
      config: { WP_HOME: 'http://localhost' },
      env: { development: {
        port: 9999,
        core: 'WordPress/WordPress#6.9',
        phpVersion: '8.2',
        plugins: ['./plugins/ignored'],
        themes: ['./themes/ignored'],
        mappings: { 'wp-content/uploads': './ignored-uploads' },
        config: { WP_HOME: 'https://example.com' },
      } },
    };
    expect(effectiveWpEnvPort(config, {})).toBe(8891);
    expect(effectiveWpEnvPort(config, { WP_ENV_PORT: '8893' })).toBe(8893);
    expect(effectiveWpEnvUrl(config, {})).toBe('http://localhost:8891');
    expect(effectiveWpEnvConfig(config)).toMatchObject({
      core: config.core, phpVersion: config.phpVersion,
      plugins: config.plugins, themes: config.themes, mappings: config.mappings,
    });
    const output = path.join(root, 'runtime.json');
    await writeThemeRuntimeConfig(config, path.join(root, 'source.json'), { slug: 'fixture-theme' } as never, '/stage/fixture-theme', output);
    const runtime = JSON.parse(await readFile(output, 'utf8'));
    expect(runtime.plugins).toEqual([path.resolve('plugins/root-helper')]);
    expect(runtime.themes).toEqual([path.resolve('themes/root-theme'), '/stage/fixture-theme']);
    expect(runtime.mappings).toEqual({ 'wp-content/uploads': path.resolve('root-uploads') });
    expect(effectiveWpEnvConfig(runtime)).toMatchObject({ core: config.core, phpVersion: config.phpVersion });
  });

  it('saves the mounted editor blocks when they differ from the original raw source', async () => {
    const entityId = 'fixture-theme//index';
    const source = '<!-- wp:accordion {"iconPosition":"left"} --><!-- wp:accordion-heading {"iconPosition":"right"} /--><!-- /wp:accordion -->';
    const mounted = source.replace('"iconPosition":"right"', '"iconPosition":"left"');
    const blocks = [{ name: 'core/accordion', innerBlocks: [{ name: 'core/accordion-heading', attributes: { iconPosition: 'left' } }] }];
    const sourceBlocks = [{ name: 'core/accordion', innerBlocks: [{ name: 'core/accordion-heading', attributes: { iconPosition: 'right' } }] }];
    let savedContent = '';
    let custom = false;
    const entity = { id: entityId, source: 'theme', content: { raw: source } };
    const wp = {
      data: {
        resolveSelect: () => ({ getEntityRecord: async () => entity }),
        select: (store: string) => {
          if (store === 'core') return { getEntityRecord: () => entity };
          if (store === 'core/block-editor') return { getBlocks: () => blocks };
          if (store === 'core/editor') return {
            getCurrentPostId: () => entityId,
            isEditorReady: () => true,
            getEditedPostContent: () => mounted,
          };
          return {};
        },
        dispatch: () => ({
          saveEntityRecord: async (_type: string, _name: string, record: { content: string }) => {
            savedContent = record.content;
            custom = true;
            return { id: entityId, source: 'custom', wp_id: 17 };
          },
        }),
      },
      blocks: { parse: () => sourceBlocks, serialize: (value: unknown[]) => value === blocks ? mounted : source },
      apiFetch: async ({ method }: { path: string; method?: string }) => {
        if (method === 'DELETE') {
          custom = false;
          return { previous: { id: entityId, wp_id: 17 } };
        }
        if (custom) return { id: entityId, source: 'custom', wp_id: 17, content: { raw: savedContent } };
        return { id: entityId, source: 'theme', wp_id: 0, content: { raw: source } };
      },
    };
    Object.defineProperty(globalThis, 'wp', { configurable: true, value: wp });
    const page = {
      goto: async () => undefined,
      waitForFunction: async () => undefined,
      frame: () => undefined,
      locator: () => ({ first: () => ({ waitFor: async () => undefined }) }),
      evaluate: async (fn: (argument: unknown) => unknown, argument?: unknown) => argument === undefined ? undefined : fn(argument),
    };
    try {
      const result = await proveFile(page, 'fixture-theme', { file: 'templates/index.html', kind: 'template' }, 'http://localhost:8888');
      expect(savedContent).toBe(mounted);
      expect(savedContent).not.toBe(source);
      expect(result.loadedRaw).toBe(source);
      expect(result.savedRaw).toBe(mounted);
      expect(result.editorSave.editedContent).toBe(mounted);
      expect(result.status).toBe('pass');
    } finally {
      Reflect.deleteProperty(globalThis, 'wp');
    }
  });

  it('uses effective development overrides and keeps caller-relative dependencies and mappings local', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-config-'));
    const configPath = path.join(root, 'proof', 'wp-env.json');
    const dependency = path.join(root, 'plugins', 'helper');
    const localDependency = `./${path.relative(process.cwd(), dependency)}`;
    const localUploads = `./${path.relative(process.cwd(), path.join(root, 'uploads'))}`;
    const outputPath = path.join(root, 'staging', 'runtime.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await mkdir(path.join(dependency, 'vendor'), { recursive: true });
    await writeFile(path.join(dependency, 'helper.php'), '<?php /* dependency */');
    await writeFile(path.join(dependency, 'vendor', 'autoload.php'), '<?php /* vendor */');
    const sourceConfig = {
      core: 'WordPress/WordPress#6.9',
      phpVersion: '8.2',
      plugins: ['./plugins/ignored'],
      mappings: { 'wp-content/uploads': localUploads },
      env: { development: { core: 'WordPress/WordPress#7.1', phpVersion: '8.4', plugins: [localDependency] } },
    };
    await writeFile(configPath, JSON.stringify(sourceConfig));
    expect(effectiveWpEnvConfig(sourceConfig)).toMatchObject({
      core: 'WordPress/WordPress#7.1', phpVersion: '8.4', plugins: [localDependency],
    });
    const evidence = new EvidenceStore(path.join(root, 'evidence'));
    const pins = await pinLocalPluginDirectories([localDependency], process.cwd(), evidence);
    const pin = pins[0] as { sha256: string; path: string; localPath: string };
    const manifest = JSON.parse((await evidence.read(pin.sha256 as `sha256:${string}`)).toString('utf8')) as { files: Array<{ file: string }> };
    expect(manifest.files.map((file) => file.file)).toContain('vendor/autoload.php');
    await writeThemeRuntimeConfig(sourceConfig, configPath, { slug: 'fixture-theme' } as never, '/stage/fixture-theme', outputPath);
    const runtime = JSON.parse(await (await import('node:fs/promises')).readFile(outputPath, 'utf8')) as {
      mappings: Record<string, string>;
      themes: string[];
      plugins: string[];
      env: { development: { plugins: string[] } };
    };
    expect(runtime.themes).toContain('/stage/fixture-theme');
    expect(runtime.mappings['wp-content/themes/fixture-theme']).toBeUndefined();
    expect(runtime.mappings['wp-content/uploads']).toBe(path.resolve(process.cwd(), localUploads));
    expect(runtime.env.development.plugins).toEqual([dependency]);
  });

  it('retains top-level configuration pins for existing plugin profiles', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-plugin-config-'));
    const config = path.join(root, 'wp-env.json');
    await writeFile(config, JSON.stringify({
      core: 'WordPress/WordPress#7.1', phpVersion: '8.3',
      env: { development: { core: 'WordPress/WordPress#6.9', phpVersion: '8.4' } },
    }));
    const result = await runProof({
      profile: 'headless', input: 'original profile', wpEnvConfig: config,
      outputDir: path.join(root, 'receipts'),
      gateRunner: async () => ({ status: 'blocked', reason: 'Configuration-pin control only.' }),
    });
    expect(result.receipt.environment.wordpress.coreSource).toBe('WordPress/WordPress#7.1');
    expect(result.receipt.environment.php.requestedVersion).toBe('8.3');
  });

  it('blocks an unsupported Requires PHP before calling the command runner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-preflight-'));
    const theme = path.join(root, 'fixture-theme');
    const config = path.join(root, 'wp-env.json');
    const outputDir = path.join(root, 'receipts');
    await mkdir(path.join(theme, 'templates'), { recursive: true });
    await writeFile(path.join(theme, 'style.css'), '/*\nTheme Name: Fixture\nVersion: 1.0.0\nRequires PHP: 8.4\n*/\n');
    await writeFile(path.join(theme, 'templates', 'index.html'), '<!-- wp:paragraph --><p>Fixture</p><!-- /wp:paragraph -->');
    await writeFile(config, JSON.stringify({
      core: 'WordPress/WordPress#7.1',
      phpVersion: '8.2',
      env: { development: { port: 9999 } },
    }));
    let commands = 0;
    const result = await runProof({
      theme,
      wpEnvConfig: config,
      outputDir,
      commandRunner: async () => {
        commands++;
        return { command: 'unexpected', args: [], exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(commands).toBe(0);
    expect(result.receipt.selectedProfile).toBe('theme');
    expect(result.receipt.ok).toBe(false);
    expect(result.receipt.requirements?.missingInputs[0]).toContain('Theme requires PHP 8.4');
    expect(result.receipt.gates.every((gate) => gate.status === 'blocked')).toBe(true);
    const pinnedInput = result.receipt.environment.input;
    expect(pinnedInput?.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('records an incomplete browser round-trip as a failed receipt without throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-failed-roundtrip-'));
    const theme = path.join(root, 'fixture-theme');
    const config = path.join(root, 'wp-env.json');
    const outputDir = path.join(root, 'receipts');
    await mkdir(path.join(theme, 'templates'), { recursive: true });
    await writeFile(path.join(theme, 'style.css'), '/*\nTheme Name: Fixture\nVersion: 1.0.0\n*/\n');
    await writeFile(path.join(theme, 'templates', 'index.html'), '<!-- wp:paragraph --><p>Fixture</p><!-- /wp:paragraph -->');
    await writeFile(config, JSON.stringify({ core: 'WordPress/WordPress#7.1', phpVersion: '8.4' }));
    let blogdescription = 'Original site description';
    const result = await runProof({
      theme,
      wpEnvConfig: config,
      outputDir,
      commandRunner: async (command, args, options) => {
        if (args.includes('option') && args.includes('get') && args.includes('blogdescription')) {
          return { command, args: [...args], exitCode: 0, stdout: JSON.stringify(blogdescription), stderr: '' };
        }
        if (args.includes('option') && args.includes('update') && args.includes('blogdescription')) {
          blogdescription = args[args.indexOf('blogdescription') + 1]!;
          return { command, args: [...args], exitCode: 0, stdout: 'Success', stderr: '' };
        }
        if (options.phase === 'browser-theme-save') {
          const output = args[args.indexOf('--out') + 1]!;
          await writeFile(output, JSON.stringify({
            theme: 'fixture-theme',
            runtimeBinding: { verified: true },
            files: [{ file: 'templates/index.html', status: 'fail', reason: 'incomplete browser report' }],
          }));
          return { command, args: [...args], exitCode: 1, stdout: '', stderr: '' };
        }
        return { command, args: [...args], exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(result.receipt.ok).toBe(false);
    const roundtrip = result.receipt.gates.find((gate) => gate.gate === 'theme_roundtrip');
    expect(roundtrip?.status).toBe('fail');
    expect(roundtrip?.details).toMatchObject({
      files: [{ file: 'templates/index.html', status: 'fail' }],
    });
    expect(blogdescription).toBe('Original site description');
  });

  it('omits the redundant browser fix payload and retains the final fix comparison', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-roundtrip-fix-'));
    const theme = path.join(root, 'fixture-theme');
    const config = path.join(root, 'wp-env.json');
    const outputDir = path.join(root, 'receipts');
    const markup = '<!-- wp:paragraph --><p>Fixture</p><!-- /wp:paragraph -->';
    await mkdir(path.join(theme, 'templates'), { recursive: true });
    await writeFile(path.join(theme, 'style.css'), '/*\nTheme Name: Fixture\nVersion: 1.0.0\n*/\n');
    await writeFile(path.join(theme, 'templates', 'index.html'), markup);
    await writeFile(config, JSON.stringify({ core: 'WordPress/WordPress#7.1', phpVersion: '8.4' }));
    let blogdescription = 'Original site description';
    let browserFiles: Array<Record<string, unknown>> = [];
    const result = await runProof({
      theme,
      wpEnvConfig: config,
      outputDir,
      commandRunner: async (command, args, options) => {
        if (args.includes('option') && args.includes('get') && args.includes('blogdescription')) {
          return { command, args: [...args], exitCode: 0, stdout: JSON.stringify(blogdescription), stderr: '' };
        }
        if (args.includes('option') && args.includes('update') && args.includes('blogdescription')) {
          blogdescription = args[args.indexOf('blogdescription') + 1]!;
          return { command, args: [...args], exitCode: 0, stdout: 'Success', stderr: '' };
        }
        if (options.phase === 'browser-theme-save') {
          const configPath = args[args.indexOf('--config') + 1]!;
          const browserConfig = JSON.parse(await readFile(configPath, 'utf8')) as { files: Array<Record<string, unknown>> };
          browserFiles = browserConfig.files;
          const output = args[args.indexOf('--out') + 1]!;
          await writeFile(output, JSON.stringify({
            theme: 'fixture-theme',
            runtimeBinding: { verified: true },
            files: [{
              file: 'templates/index.html',
              status: 'pass',
              loadedRaw: markup,
              savedRaw: markup,
              editorSave: { serialized: markup },
            }],
          }));
          return { command, args: [...args], exitCode: 0, stdout: '', stderr: '' };
        }
        return { command, args: [...args], exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(browserFiles).toHaveLength(1);
    expect(browserFiles[0]).not.toHaveProperty('fix');
    const roundtrip = result.receipt.gates.find((gate) => gate.gate === 'theme_roundtrip');
    expect(roundtrip?.status).toBe('pass');
    expect(roundtrip?.details).toMatchObject({
      files: [{
        file: 'templates/index.html',
        fixComparison: { equal: false },
        sourceLoadComparison: { equal: true },
        sourceComparison: { equal: true },
        editorRestComparison: { equal: true },
      }],
    });
    expect(blogdescription).toBe('Original site description');
  });
});
