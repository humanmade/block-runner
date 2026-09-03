import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  assertStandaloneZipEntries,
  detectWpScriptsPlugin,
  planExistingPluginOutput,
  planStandalonePluginOutput,
  UnsupportedPluginLayoutError,
  writePluginOutput,
} from '../src/plugin/profile.js';

const execFileAsync = promisify(execFile);

const block = {
  name: 'acme/notice',
  files: {
    'block.json': JSON.stringify({
      '$schema': 'https://schemas.wp.org/trunk/block.json',
      apiVersion: 3,
      name: 'acme/notice',
      title: 'Notice',
      category: 'widgets',
      editorScript: 'file:./index.js',
    }, null, 2),
    'index.js': "import { registerBlockType } from '@wordpress/blocks';\nimport metadata from './block.json';\nregisterBlockType( metadata.name, { edit: () => 'Notice', save: () => 'Notice' } );\n",
    'style.css': '.wp-block-acme-notice { color: rebeccapurple; }\n',
  },
};

describe('wp-scripts plugin profile', () => {
  it('recognises the direct registration profile and requires a separate bootstrap replacement approval', async () => {
    const root = await existingDirectPlugin();
    const profile = await detectWpScriptsPlugin(root);

    expect(profile).toMatchObject({
      kind: 'recognized',
      wpScriptsVersion: '34.2.0',
      sourceRoot: 'src/blocks',
      buildRoot: 'build/blocks',
      registration: 'direct',
    });

    const plan = await planExistingPluginOutput(root, block);
    expect(plan.targetDirectory).toBe(path.join(root, 'src', 'blocks', 'notice'));
    await expect(stat(path.join(root, 'src', 'blocks', 'notice'))).rejects.toThrow();
    expect(plan.touchedFiles.map((file) => [file.relativePath, file.operation])).toEqual([
      ['main.php', 'modify'],
      ['src/blocks/notice/block.json', 'create'],
      ['src/blocks/notice/index.js', 'create'],
      ['src/blocks/notice/style.css', 'create'],
    ]);
    expect(plan.notes).toContain(`Build target after npm run build: ${path.join(root, 'build', 'blocks', 'notice')}`);
    await expect(writePluginOutput(plan)).rejects.toThrow('Separate explicit authorization');
    expect(await readFile(path.join(root, 'main.php'), 'utf8')).not.toContain("'/build/blocks/notice'");

    const modified = plan.touchedFiles.filter((file) => file.operation === 'modify').map((file) => file.path);
    await writePluginOutput(plan, { authorizedReplacements: modified });
    expect(await readFile(path.join(root, 'main.php'), 'utf8')).toContain("register_block_type( __DIR__ . '/build/blocks/notice' );");
    expect(await stat(path.join(root, 'src', 'blocks', 'notice', 'block.json'))).toBeTruthy();
  });

  it('extends a named metadata collection with the output-root-relative manifest key', async () => {
    const root = await existingCollectionPlugin(false);
    const plan = await planExistingPluginOutput(root, block);
    const php = plan.touchedFiles.find((file) => file.relativePath === 'plugin.php');
    const packageFile = plan.touchedFiles.find((file) => file.relativePath === 'package.json');

    expect(plan.profile?.metadataCollection).toEqual({
      directory: path.join(root, 'build'),
      manifest: path.join(root, 'build', 'blocks-manifest.php'),
      key: 'blocks/notice',
    });
    expect(php?.content.toString()).toContain("register_block_type_from_metadata_collection( $build_dir, 'blocks/notice' );");
    expect(packageFile?.content.toString()).toContain('--blocks-manifest');
    expect(plan.touchedFiles.every((file) => path.isAbsolute(file.path))).toBe(true);
  });

  it('does not edit a bulk metadata bootstrap and relies on the generated blocks manifest', async () => {
    const root = await existingCollectionPlugin(true);
    const plan = await planExistingPluginOutput(root, block);

    expect(plan.touchedFiles.some((file) => file.relativePath === 'plugin.php')).toBe(false);
    expect(plan.profile?.metadataCollection?.key).toBe('blocks/notice');
    expect(plan.notes.join('\n')).toContain('blocks-manifest.php');
  });

  it('fails unsupported layouts before writes and exposes the standalone choice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-plugin-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));

    const profile = await detectWpScriptsPlugin(root);
    expect(profile).toMatchObject({ kind: 'unsupported', standaloneAvailable: true });
    await expect(planExistingPluginOutput(root, block)).rejects.toBeInstanceOf(UnsupportedPluginLayoutError);
    await expect(stat(path.join(root, 'src'))).rejects.toThrow();
  });

  it('rejects positional wp-scripts build entries because they bypass metadata entry discovery', async () => {
    const root = await existingDefaultDirectPlugin('wp-scripts build custom.js');

    await expect(detectWpScriptsPlugin(root)).resolves.toMatchObject({
      kind: 'unsupported',
      standaloneAvailable: true,
    });
  });

  it('rejects version ranges and webpack configurations that wp-scripts loads implicitly', async () => {
    const ranged = await existingDirectPlugin();
    await writeFile(path.join(ranged, 'package.json'), JSON.stringify({
      devDependencies: { '@wordpress/scripts': '^34.2.0' },
      scripts: { build: 'wp-scripts build --source-path=src/blocks --output-path=build/blocks' },
    }));
    await expect(detectWpScriptsPlugin(ranged)).resolves.toMatchObject({ kind: 'unsupported' });

    const configured = await existingDirectPlugin();
    await writeFile(path.join(configured, 'webpack.config.babel.js'), 'module.exports = {};\n');
    await expect(detectWpScriptsPlugin(configured)).resolves.toMatchObject({
      kind: 'unsupported',
      reason: expect.stringContaining('webpack.config.babel.js'),
    });
  });

  it('preserves replacement modes and writes binary generated assets byte-for-byte', async () => {
    const root = await existingDirectPlugin();
    const bootstrap = path.join(root, 'main.php');
    await chmod(bootstrap, 0o640);
    const font = Buffer.from([0, 255, 4, 0, 128, 18]);
    const binaryBlock = { ...block, files: { ...block.files, 'assets/notice.woff2': font } };

    const plan = await planExistingPluginOutput(root, binaryBlock);
    const modified = plan.touchedFiles.filter((file) => file.operation === 'modify').map((file) => file.path);
    await writePluginOutput(plan, { authorizedReplacements: modified });

    expect((await stat(bootstrap)).mode & 0o777).toBe(0o640);
    expect(await readFile(path.join(root, 'src', 'blocks', 'notice', 'assets', 'notice.woff2'))).toEqual(font);
  });
});

describe('standalone plugin profile', () => {
  it('plans a pinned clean-install wrapper, ZIP policy, runtime bootstrap, and every generated source file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-standalone-'));
    const output = path.join(root, 'notice-plugin');
    const plan = await planStandalonePluginOutput(output, block);

    expect(plan.mode).toBe('standalone');
    expect(plan.targetDirectory).toBe(output);
    await expect(stat(output)).rejects.toThrow();
    expect(plan.touchedFiles.map((file) => file.relativePath)).toEqual(expect.arrayContaining([
      'package.json',
      'package-lock.json',
      'plugin.php',
      'readme.txt',
      '.distignore',
      'scripts/verify-zip.mjs',
      'src/blocks/notice/block.json',
      'src/blocks/notice/index.js',
      'src/blocks/notice/style.css',
    ]));
    const packageJson = plan.touchedFiles.find((file) => file.relativePath === 'package.json')!.content;
    const lock = plan.touchedFiles.find((file) => file.relativePath === 'package-lock.json')!.content;
    const bootstrap = plan.touchedFiles.find((file) => file.relativePath === 'plugin.php')!.content;
    expect(JSON.parse(packageJson.toString('utf8'))).toMatchObject({ devDependencies: { '@wordpress/scripts': '34.2.0' } });
    expect(JSON.parse(lock.toString('utf8'))).toMatchObject({
      lockfileVersion: 3,
      packages: { '': { name: 'acme-notice', devDependencies: { '@wordpress/scripts': '34.2.0' } } },
    });
    expect(bootstrap.toString()).toContain('wp_register_block_metadata_collection');
    expect(bootstrap.toString()).toContain("register_block_type( $build_dir . '/blocks/notice' );");
    expect(packageJson.toString()).not.toContain('npx');
  });

  it('validates every metadata runtime file and accepts the normal plugin-zip root folder', () => {
    expect(() => assertStandaloneZipEntries([
      'acme-notice/plugin.php',
      'acme-notice/readme.txt',
      'acme-notice/package.json',
      'acme-notice/build/blocks/notice/block.json',
      'acme-notice/build/blocks/notice/view.js',
      'acme-notice/build/blocks/notice/style-index.css',
    ], 'notice', ['view.js', 'style-index.css'])).not.toThrow();
    expect(() => assertStandaloneZipEntries([
      'plugin.php',
      'readme.txt',
      'build/blocks/notice/block.json',
      'build/blocks/notice/view.js',
    ], 'notice', ['view.js', 'style-index.css'])).toThrow('style-index.css');
    expect(() => assertStandaloneZipEntries([
      'plugin.php',
      'readme.txt',
      'build/blocks/notice/block.json',
      '.env.production',
    ], 'notice')).toThrow('excluded local/private file');
    expect(() => assertStandaloneZipEntries([
      'plugin.php',
      'readme.txt',
      'build/blocks/notice/block.json',
      'notes/private.txt',
    ], 'notice')).toThrow('runtime allowlist');
  });

  it('resolves, clean-installs, builds, and inspects the actual release archive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-release-'));
    const output = path.join(root, 'notice-plugin');
    const plan = await planStandalonePluginOutput(output, block);

    await writePluginOutput(plan);
    const lock = JSON.parse(await readFile(path.join(output, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages['node_modules/@wordpress/scripts']?.version).toBe('34.2.0');
    await expect(stat(path.join(output, 'node_modules'))).rejects.toThrow();

    await execFileAsync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: output });
    await execFileAsync('npm', ['run', 'zip'], { cwd: output });
    const archive = path.join(output, 'acme-notice.zip');
    expect(await stat(archive)).toBeTruthy();
    await execFileAsync('npm', ['run', 'test:zip', '--', archive], { cwd: output });

    const { stdout } = await execFileAsync('unzip', ['-Z1', archive]);
    expect(() => assertStandaloneZipEntries(stdout.split(/\r?\n/).filter(Boolean), 'notice', ['index.js'])).not.toThrow();
  }, 300_000);
});

async function existingDirectPlugin(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-plugin-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    devDependencies: { '@wordpress/scripts': '34.2.0' },
    scripts: { build: 'wp-scripts build --source-path src/blocks --output-path build/blocks' },
  }, null, 2));
  await writeFile(path.join(root, 'main.php'), `<?php\nadd_action( 'init', function() {\n\tregister_block_type( __DIR__ . '/build/blocks/existing' );\n} );\n`);
  await writeSourceBlock(root, 'src/blocks/existing');
  return root;
}

/** A valid default-roots host makes the positional-entry regression observable. */
async function existingDefaultDirectPlugin(build: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-plugin-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    devDependencies: { '@wordpress/scripts': '34.2.0' },
    scripts: { build },
  }, null, 2));
  await writeFile(path.join(root, 'main.php'), `<?php\nadd_action( 'init', function() {\n\tregister_block_type( __DIR__ . '/build/existing' );\n} );\n`);
  await writeSourceBlock(root, 'src/existing');
  return root;
}

async function existingCollectionPlugin(bulk: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-plugin-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    devDependencies: { '@wordpress/scripts': '34.2.0' },
    scripts: { build: 'wp-scripts build --source-path=src --output-path=build' },
  }, null, 2));
  const registration = bulk
    ? `wp_register_block_metadata_collection( $build_dir, $manifest );\n\twp_register_block_types_from_metadata_collection( $build_dir );`
    : `wp_register_block_metadata_collection( $build_dir, $manifest );\n\tregister_block_type_from_metadata_collection( $build_dir, 'acme/existing' );`;
  await writeFile(path.join(root, 'plugin.php'), `<?php\nadd_action( 'init', function() {\n\t$build_dir = __DIR__ . '/build';\n\t$manifest = $build_dir . '/blocks-manifest.php';\n\t${registration}\n} );\n`);
  await writeSourceBlock(root, 'src/blocks/existing');
  return root;
}

async function writeSourceBlock(root: string, relative: string): Promise<void> {
  const source = path.join(root, relative);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'block.json'), JSON.stringify({ name: 'acme/existing' }));
}
