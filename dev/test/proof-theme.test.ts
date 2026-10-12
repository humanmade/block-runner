import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareThemeMarkup,
  effectiveWpEnvConfig,
  pinLocalPluginDirectories,
  removeThemeAttributes,
  writeThemeRuntimeConfig,
} from '../../src/proof/theme.js';
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
    const result = await runProof({
      theme,
      wpEnvConfig: config,
      outputDir,
      commandRunner: async (command, args, options) => {
        if (options.phase === 'browser-theme-save') {
          const output = args[args.indexOf('--out') + 1]!;
          await writeFile(output, JSON.stringify({
            theme: 'fixture-theme',
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
  });
});
