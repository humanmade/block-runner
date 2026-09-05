import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { compileRegisteredBlock, registeredBlockFontFamilyPrefix } from '../src/authoring/generate.js';
import { PROOF_IMAGE_BASE64 } from '../src/proof/fixture-image.js';
import {
  assertStandaloneZipEntries,
  detectWpScriptsPlugin,
  planExistingPluginOutput,
  planStandalonePluginOutput,
  npmEnvironmentForGeneratedPlugin,
  PublicationInterruptedError,
  removeMatchingAllowScriptsProjection,
  retryPluginPublication,
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

  it('extends selective metadata registration with a real WordPress API and leaf manifest key', async () => {
    const root = await existingCollectionPlugin(false);
    const plan = await planExistingPluginOutput(root, block);
    const php = plan.touchedFiles.find((file) => file.relativePath === 'plugin.php');
    const packageFile = plan.touchedFiles.find((file) => file.relativePath === 'package.json');

    expect(plan.profile?.metadataCollection).toEqual({
      directory: path.join(root, 'build/blocks'),
      manifest: path.join(root, 'build', 'blocks-manifest.php'),
      key: 'notice',
    });
    expect(php?.content.toString()).toContain("register_block_type( $blocks_dir . '/notice' );");
    expect(packageFile?.content.toString()).toContain('--blocks-manifest');
    expect(plan.touchedFiles.every((file) => path.isAbsolute(file.path))).toBe(true);
  });

  it('retains an exact recovery inventory when failure interrupts publication between two approved replacements', async () => {
    const root = await existingCollectionPlugin(false);
    const plan = await planExistingPluginOutput(root, block);
    const replacements = plan.touchedFiles.filter((file) => file.operation === 'modify');
    expect(replacements).toHaveLength(2);
    const original = new Map(await Promise.all(replacements.map(async (file) => [file.path, await readFile(file.path)] as const)));

    let interrupted: PublicationInterruptedError | undefined;
    try {
      await writePluginOutput(plan, {
        authorizedReplacements: replacements.map((file) => file.path),
        failAfterPublishStep: 1,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationInterruptedError);
      interrupted = error as PublicationInterruptedError;
    }
    expect(interrupted).toBeDefined();
    const recovery = interrupted!.recovery;
    expect(recovery.completed).toHaveLength(1);
    expect(recovery.pending).toHaveLength(plan.touchedFiles.length - 1);
    expect(recovery.replacements).toHaveLength(1);
    expect(recovery.recordPath).toBeDefined();
    expect(recovery.recordPath!.startsWith(`${root}${path.sep}`)).toBe(false);
    const completed = recovery.completed[0]!;
    expect(completed.beforeHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(completed.afterHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(completed.beforeContent).toEqual(original.get(completed.path));
    const pendingReplacement = recovery.pending.find((entry) => original.has(entry.path));
    expect(pendingReplacement?.beforeContent).toEqual(original.get(pendingReplacement!.path));

    await retryPluginPublication(recovery);
    for (const file of plan.touchedFiles) {
      expect(await readFile(file.path)).toEqual(file.content);
    }
    await expect(stat(recovery.recordPath!)).rejects.toThrow();
  });

  it('reports exact completed and pending paths for every recognised-plugin publication step', async () => {
    for (let failAfterPublishStep = 1; failAfterPublishStep <= 4; failAfterPublishStep += 1) {
      const root = await existingDirectPlugin();
      const plan = await planExistingPluginOutput(root, block);
      let interrupted: PublicationInterruptedError | undefined;
      try {
        await writePluginOutput(plan, {
          authorizedReplacements: plan.touchedFiles.filter((file) => file.operation === 'modify').map((file) => file.path),
          failAfterPublishStep,
        });
      } catch (error) {
        interrupted = error as PublicationInterruptedError;
      }
      expect(interrupted).toBeInstanceOf(PublicationInterruptedError);
      const recovery = interrupted!.recovery;
      expect(recovery.completed.map((entry) => entry.path)).toEqual(plan.touchedFiles.slice(0, failAfterPublishStep).map((file) => file.path));
      expect(recovery.pending.map((entry) => entry.path)).toEqual(plan.touchedFiles.slice(failAfterPublishStep).map((file) => file.path));
      expect(recovery.replacements.map((entry) => entry.path)).toEqual(plan.touchedFiles
        .slice(0, failAfterPublishStep).filter((file) => file.operation === 'modify').map((file) => file.path));
      expect(recovery.completed.concat(recovery.pending).every((entry) => entry.afterHash.startsWith('sha256:'))).toBe(true);
      await retryPluginPublication(recovery);
    }
  });

  it('reports a conflict when a callback changes a published target before success', async () => {
    const root = await existingDirectPlugin();
    const plan = await planExistingPluginOutput(root, block);
    const modified = plan.touchedFiles.filter((file) => file.operation === 'modify').map((file) => file.path);
    const first = plan.touchedFiles[0]!;

    await expect(writePluginOutput(plan, {
      authorizedReplacements: modified,
      onPublished: async (_entry, recovery) => {
        if (recovery.pending.length === 0) await writeFile(first.path, 'changed after publication\n');
      },
    })).rejects.toThrow(/plugin publication conflict/);
  });

  it('does not report a changed published target as completed after an interruption', async () => {
    const root = await existingDirectPlugin();
    const plan = await planExistingPluginOutput(root, block);
    const modified = plan.touchedFiles.filter((file) => file.operation === 'modify').map((file) => file.path);
    let interrupted: PublicationInterruptedError | undefined;
    try {
      await writePluginOutput(plan, {
        authorizedReplacements: modified,
        onPublished: async (entry) => {
          await writeFile(entry.path, 'changed after publication\n');
          throw new Error('interrupt after external change');
        },
      });
    } catch (error) {
      interrupted = error as PublicationInterruptedError;
    }

    expect(interrupted).toBeInstanceOf(PublicationInterruptedError);
    expect(interrupted!.recovery.completed).toEqual([]);
    expect(interrupted!.recovery.pending.map((entry) => entry.path)).toEqual(plan.touchedFiles.map((file) => file.path));
  });

  it('refuses to retry over a pending replacement changed by another process', async () => {
    const root = await existingCollectionPlugin(false);
    const plan = await planExistingPluginOutput(root, block);
    const replacements = plan.touchedFiles.filter((file) => file.operation === 'modify');
    let interrupted: PublicationInterruptedError | undefined;
    try {
      await writePluginOutput(plan, {
        authorizedReplacements: replacements.map((file) => file.path),
        failAfterPublishStep: 1,
      });
    } catch (error) {
      interrupted = error as PublicationInterruptedError;
    }
    expect(interrupted).toBeInstanceOf(PublicationInterruptedError);
    const pending = interrupted!.recovery.pending.find((entry) => replacements.some((file) => file.path === entry.path))!;
    await writeFile(pending.path, 'changed by another process\n');

    await expect(retryPluginPublication(interrupted!.recovery)).rejects.toThrow('pending replacement changed');
    expect(await readFile(pending.path, 'utf8')).toBe('changed by another process\n');
  });

  it('plans font notice transport for an existing plugin without replacing its postbuild hook', async () => {
    const root = await existingDirectPlugin();
    const packagePath = path.join(root, 'package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    pkg.scripts.postbuild = 'node existing-check.mjs';
    await writeFile(packagePath, JSON.stringify(pkg));
    const plan = await planExistingPluginOutput(root, {
      ...block, files: { ...block.files, 'font-licenses.txt': 'Retained font copyright and license.' },
    });
    const packageChange = plan.touchedFiles.find((file) => file.path === packagePath)!;
    expect(JSON.parse(packageChange.content.toString()).scripts.postbuild)
      .toBe('node existing-check.mjs && node scripts/block-runner-copy-font-licenses-notice.mjs');
    await expect(writePluginOutput(plan)).rejects.toThrow('Separate explicit authorization');
    await writePluginOutput(plan, { authorizedReplacements: plan.touchedFiles
      .filter((file) => file.operation === 'modify').map((file) => file.path) });
    await execFileAsync(process.execPath, ['scripts/block-runner-copy-font-licenses-notice.mjs'], { cwd: root });
    expect(await readFile(path.join(root, 'build/blocks/notice/font-licenses.txt'), 'utf8'))
      .toBe('Retained font copyright and license.');
  });

  it('does not edit a bulk metadata bootstrap and relies on the generated blocks manifest', async () => {
    const root = await existingCollectionPlugin(true);
    const plan = await planExistingPluginOutput(root, block);

    expect(plan.touchedFiles.some((file) => file.relativePath === 'plugin.php')).toBe(false);
    expect(plan.profile?.metadataCollection?.key).toBe('notice');
    expect(plan.notes.join('\n')).toContain('blocks-manifest.php');
  });

  it('rejects the nonexistent singular metadata API and the wrong manifest base directory', async () => {
    const singular = await existingCollectionPlugin(false);
    const singularPhp = path.join(singular, 'plugin.php');
    await writeFile(singularPhp, (await readFile(singularPhp, 'utf8'))
      .replace("register_block_type( $blocks_dir . '/existing' );", "register_block_type_from_metadata_collection( $blocks_dir, 'existing' );"));
    await expect(detectWpScriptsPlugin(singular)).resolves.toMatchObject({ kind: 'unsupported' });

    const wrongRoot = await existingCollectionPlugin(true);
    const php = path.join(wrongRoot, 'plugin.php');
    await writeFile(php, (await readFile(php, 'utf8')).replaceAll('( $blocks_dir', '( $build_dir'));
    await expect(detectWpScriptsPlugin(wrongRoot)).resolves.toMatchObject({ kind: 'unsupported' });
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
  it('removes only an exact npm user-config projection and preserves a different explicit policy', () => {
    const userConfigValue = '@example/approved-script';
    const projected = { ...process.env, npm_config_allow_scripts: userConfigValue };
    const stripped = removeMatchingAllowScriptsProjection(projected, userConfigValue);
    expect(stripped.npm_config_allow_scripts).toBeUndefined();

    const explicit = `${userConfigValue}-explicit-different`;
    const preserved = removeMatchingAllowScriptsProjection(
      { ...process.env, npm_config_allow_scripts: explicit },
      userConfigValue,
    );
    expect(preserved.npm_config_allow_scripts).toBe(explicit);

    const missingConfig = removeMatchingAllowScriptsProjection(projected, 'undefined');
    expect(missingConfig.npm_config_allow_scripts).toBe(userConfigValue);
  });

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
    expect(bootstrap.toString()).toContain('Requires at least: 7.1');
    expect(bootstrap.toString()).toContain('Requires PHP: 7.4');
    const readme = plan.touchedFiles.find((file) => file.relativePath === 'readme.txt')!.content.toString();
    expect(readme).toContain('Requires at least: 7.1');
    expect(readme).toContain('Tested up to: 7.1');
    expect(readme).toContain('Requires PHP: 7.4');
    // wp-scripts keys its manifest by the leaf directory, while this profile
    // emits blocks below build/blocks. Registering build alone loses asset paths.
    expect(bootstrap.toString()).toContain("wp_register_block_metadata_collection( $build_dir . '/blocks', $manifest );");
    expect(bootstrap.toString()).toContain("wp_register_block_types_from_metadata_collection( $build_dir . '/blocks', $manifest );");
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
    const image = Buffer.from(PROOF_IMAGE_BASE64, 'base64');
    const sourceImage = path.join(root, 'photo.png');
    await writeFile(sourceImage, image);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><path d="M0 0h80v40H0z" fill="#123456"/></svg>');
    const sourceSvg = path.join(root, 'logo.svg');
    await writeFile(sourceSvg, svg);
    const sourceFont = path.resolve('test/fixtures/fonts/IBMPlexMono-Regular.woff2');
    const font = await readFile(sourceFont);
    const fontNotice = await readFile(path.resolve('test/fixtures/fonts/OFL.txt'), 'utf8');
    const fontFamily = `${registeredBlockFontFamilyPrefix('acme/notice')}body`;
    // Exercise the public compiler, not the small hand-written source stub used by profile unit tests.
    const generated = compileRegisteredBlock({
      version: 1, generatorVersion: '0.9.0', target: { name: 'acme/notice', title: 'Notice' },
      structure: [{ block: 'core/group', attributes: { className: 'card' }, children: [
        { block: 'core/paragraph', attributes: { content: 'Packaged native content' } },
        { id: 'logo', block: 'core/image', attributes: { alt: 'Logo', className: 'logo' } },
      ] }],
      fields: [], locking: { mode: 'contentOnly' }, pattern: { ready: false, overrides: [] },
      styles: { strategy: 'mixed', outcomes: [],
        fonts: [{ assetId: 'body-font', family: fontFamily, fontWeight: '400', fontDisplay: 'swap' }], rules: [
        { kind: 'style', selector: '.card', declarations: [{ property: 'font-family', value: `"${fontFamily}", monospace` }] },
        { kind: 'style', selector: '.card', declarations: [{ property: 'background-image', value: 'url("./assets/photo.png")' }] },
        { kind: 'style', selector: '.logo', declarations: [{ property: 'mask-image', value: 'url("./assets/logo.svg")' }] },
        { kind: 'conditional', name: 'media', prelude: '(min-width: 48rem)', rules: [
          { kind: 'style', selector: '.card:hover', declarations: [{ property: 'transform', value: 'translateY(-2px)' }] },
        ] },
      ], editorRules: [
        { kind: 'style', selector: '.card:focus-within', declarations: [{ property: 'outline', value: '2px solid blue' }] },
      ] },
      assets: [{ id: 'photo', source: sourceImage, status: 'ready', destination: 'assets/photo.png',
        sha256: createHash('sha256').update(image).digest('hex') },
      { id: 'logo', source: sourceSvg, status: 'ready', destination: 'assets/logo.svg',
        sha256: createHash('sha256').update(svg).digest('hex'), uses: [{ node: 'logo', attribute: 'url' }] },
      { id: 'body-font', source: sourceFont, kind: 'font', status: 'ready', destination: 'assets/body.woff2',
        sha256: createHash('sha256').update(font).digest('hex'),
        fontLicense: { ownership: 'IBM Corp.', license: 'OFL-1.1', notice: fontNotice } }], files: [], warnings: [],
    });
    const plan = await planStandalonePluginOutput(output, { name: 'acme/notice',
      files: Object.fromEntries([...generated.files, ...generated.assets].map((file) => [file.path, file.content])) });

    await writePluginOutput(plan);
    const lock = JSON.parse(await readFile(path.join(output, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages['node_modules/@wordpress/scripts']?.version).toBe('34.2.0');
    await expect(stat(path.join(output, 'node_modules'))).rejects.toThrow();

    const npmEnvironment = await npmEnvironmentForGeneratedPlugin(output);
    await execFileAsync('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], {
      cwd: output,
      timeout: 120_000,
      env: npmEnvironment,
    });
    await execFileAsync('npm', ['run', 'zip'], { cwd: output, timeout: 120_000,
      env: { ...npmEnvironment, NODE_ENV: 'production' } });
    const archive = path.join(output, 'acme-notice.zip');
    expect(await stat(archive)).toBeTruthy();
    await execFileAsync('npm', ['run', 'test:zip', '--', archive], { cwd: output, timeout: 30_000 });

    const { stdout } = await execFileAsync('unzip', ['-Z1', archive]);
    const entries = stdout.split(/\r?\n/).filter(Boolean);
    expect(() => assertStandaloneZipEntries(entries, 'notice', ['index.js', 'style-index.css', 'index.css'])).not.toThrow();
    const archiveBytes = async (entry: string): Promise<Buffer> =>
      (await execFileAsync('unzip', ['-p', archive, entry], { encoding: 'buffer', timeout: 10_000 })).stdout;
    const sharedCssPath = entries.find((entry) => entry.endsWith('/blocks/notice/style-index.css'))!;
    const editorCssPath = entries.find((entry) => entry.endsWith('/blocks/notice/index.css'))!;
    const css = (await archiveBytes(sharedCssPath)).toString('utf8');
    expect(css).toContain('.wp-block-acme-notice .card');
    expect(css).toMatch(/@media\s*\(min-width:\s*48rem\)/);
    expect(css).toContain('translateY(-2px)');
    expect(css).not.toContain('./assets/photo.png');
    expect(css).not.toContain('focus-within');
    expect(css).toContain('@font-face');
    expect(css).toContain(fontFamily);
    expect(css).not.toContain(sourceFont);
    const noticePath = entries.find((entry) => entry.endsWith('/blocks/notice/font-licenses.txt'));
    expect(noticePath).toBeDefined();
    const notice = (await archiveBytes(noticePath!)).toString('utf8');
    expect(notice).toContain('Copyright © 2017 IBM Corp.');
    expect(notice).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(notice).toContain('OTHER DEALINGS IN THE FONT SOFTWARE.');
    expect(notice).not.toContain(sourceFont);
    const fonts = entries.filter((entry) => /\/build\/.*\.woff2$/.test(entry));
    expect(fonts).toHaveLength(1);
    expect(await archiveBytes(fonts[0]!)).toEqual(font);
    expect(css).toContain(path.basename(fonts[0]!));
    expect((await archiveBytes(editorCssPath)).toString('utf8')).not.toContain('@font-face');
    expect((await archiveBytes(editorCssPath)).toString('utf8')).toContain('.card:focus-within');
    const images = entries.filter((entry) => /\/build\/images\/.*\.png$/.test(entry));
    expect(images).toHaveLength(1);
    expect(await archiveBytes(images[0]!)).toEqual(image);
    expect(css).toContain(path.basename(images[0]!));
    expect(entries.some((entry) => entry.endsWith('.map'))).toBe(false);
    // CSS SVGs can be inline. Native Image URLs must be emitted files because WordPress strips
    // data: URLs from filtered post content, even when the source SVG itself is safe.
    const svgData = /data:image\/svg\+xml(?:;charset=[^;,]+)?(?:;base64)?,[^)"'\s]+/.exec(css)?.[0];
    expect(svgData).toBeDefined();
    const [header, payload] = svgData!.split(',', 2);
    const cssSvg = header!.includes(';base64') ? Buffer.from(payload!, 'base64') : Buffer.from(decodeURIComponent(payload!));
    expect(cssSvg.toString()).toContain('viewBox="0 0 80 40"');
    expect(cssSvg.toString()).toContain('#123456');
    const scriptPath = entries.find((entry) => entry.endsWith('/blocks/notice/index.js'))!;
    const script = (await archiveBytes(scriptPath)).toString('utf8');
    const svgFiles = entries.filter((entry) => /\/build\/.*\.svg$/.test(entry));
    expect(svgFiles).toHaveLength(1);
    expect(await archiveBytes(svgFiles[0]!)).toEqual(svg);
    expect(script).toContain(path.basename(svgFiles[0]!));
    expect(script).not.toContain('data:image/svg+xml');
    expect(script).not.toContain('./assets/logo.svg');

    // Reuse this real installed wp-scripts host to exercise the other delivery profile.
    // Adding a second block must retain the first block's source and produce both build leaves.
    const existingSource = new Map(await Promise.all([...generated.files, ...generated.assets].map(async (file) => [
      file.path, await readFile(path.join(output, 'src/blocks/notice', file.path)),
    ] as const)));
    const addition = compileRegisteredBlock({
      version: 1, generatorVersion: '0.9.0', target: { name: 'acme/second-notice', title: 'Second notice' },
      structure: [{ id: 'message', block: 'core/paragraph', attributes: { content: 'An independently registered second block.' } }],
      fields: [{ id: 'message', node: 'message', attribute: 'content', label: 'Message', mode: 'editable' }],
      locking: { mode: 'contentOnly' }, styles: { strategy: 'native', outcomes: [] },
      pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [],
    });
    const integration = await planExistingPluginOutput(output, { name: 'acme/second-notice',
      files: Object.fromEntries(addition.files.map((file) => [file.path, file.content])) });
    expect(integration.mode).toBe('existing');
    await writePluginOutput(integration, { authorizedReplacements: integration.touchedFiles
      .filter((file) => file.operation === 'modify').map((file) => file.path) });
    for (const [relative, bytes] of existingSource) {
      expect(await readFile(path.join(output, 'src/blocks/notice', relative))).toEqual(bytes);
    }
    await execFileAsync('npm', ['run', 'zip'], { cwd: output, timeout: 120_000,
      env: { ...npmEnvironment, NODE_ENV: 'production' } });
    await execFileAsync('npm', ['run', 'test:zip', '--', archive], { cwd: output, timeout: 30_000 });
    const rebuiltEntries = (await execFileAsync('unzip', ['-Z1', archive])).stdout.split(/\r?\n/).filter(Boolean);
    for (const leaf of ['notice', 'second-notice']) {
      const metadataEntry = rebuiltEntries.find((entry) => entry.endsWith(`/build/blocks/${leaf}/block.json`));
      expect(metadataEntry).toBeDefined();
      expect(JSON.parse((await archiveBytes(metadataEntry!)).toString('utf8')).name).toBe(`acme/${leaf}`);
    }
    const manifest = await readFile(path.join(output, 'build/blocks-manifest.php'), 'utf8');
    expect(manifest).toContain("'notice'");
    expect(manifest).toContain("'second-notice'");
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
    ? `wp_register_block_metadata_collection( $blocks_dir, $manifest );\n\twp_register_block_types_from_metadata_collection( $blocks_dir );`
    : `wp_register_block_metadata_collection( $blocks_dir, $manifest );\n\tregister_block_type( $blocks_dir . '/existing' );`;
  await writeFile(path.join(root, 'plugin.php'), `<?php\nadd_action( 'init', function() {\n\t$build_dir = __DIR__ . '/build';\n\t$blocks_dir = $build_dir . '/blocks';\n\t$manifest = $build_dir . '/blocks-manifest.php';\n\t${registration}\n} );\n`);
  await writeSourceBlock(root, 'src/blocks/existing');
  return root;
}

async function writeSourceBlock(root: string, relative: string): Promise<void> {
  const source = path.join(root, relative);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'block.json'), JSON.stringify({ name: 'acme/existing' }));
}
