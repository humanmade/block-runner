import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { compileRegisteredBlock, registeredBlockFontFamilyPrefix } from '../../src/authoring/generate.js';
import { PROOF_IMAGE_BASE64 } from '../../src/proof/fixture-image.js';
import { assertStandaloneZipEntries, npmEnvironmentForGeneratedPlugin, planExistingPluginOutput, planStandalonePluginOutput, writePluginOutput } from '../../src/plugin/profile.js';

const execFileAsync = promisify(execFile);

describe('standalone consumer release archive', () => {
  it('resolves, clean-installs, builds, and inspects the actual release archive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-release-'));
    const output = path.join(root, 'notice-plugin');
    const image = Buffer.from(PROOF_IMAGE_BASE64, 'base64');
    const sourceImage = path.join(root, 'photo.png'); await writeFile(sourceImage, image);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><path d="M0 0h80v40H0z" fill="#123456"/></svg>');
    const sourceSvg = path.join(root, 'logo.svg'); await writeFile(sourceSvg, svg);
    const sourceFont = path.resolve('dev/test/fixtures/fonts/IBMPlexMono-Regular.woff2');
    const font = await readFile(sourceFont);
    const fontNotice = await readFile(path.resolve('dev/test/fixtures/fonts/OFL.txt'), 'utf8');
    const fontFamily = `${registeredBlockFontFamilyPrefix('acme/notice')}body`;
    const generated = compileRegisteredBlock({
      version: 1, generatorVersion: '0.9.0', target: { name: 'acme/notice', title: 'Notice' },
      structure: [{ block: 'core/group', attributes: { className: 'card' }, children: [{ block: 'core/paragraph', attributes: { content: 'Packaged native content' } }, { id: 'logo', block: 'core/image', attributes: { alt: 'Logo', className: 'logo' } }] }], fields: [], locking: { mode: 'contentOnly' }, pattern: { ready: false, overrides: [] },
      styles: { strategy: 'mixed', outcomes: [], fonts: [{ assetId: 'body-font', family: fontFamily, fontWeight: '400', fontDisplay: 'swap' }], rules: [
        { kind: 'style', selector: '.card', declarations: [{ property: 'font-family', value: `"${fontFamily}", monospace` }] },
        { kind: 'style', selector: '.card', declarations: [{ property: 'background-image', value: 'url("./assets/photo.png")' }] },
        { kind: 'style', selector: '.logo', declarations: [{ property: 'mask-image', value: 'url("./assets/logo.svg")' }] },
        { kind: 'conditional', name: 'media', prelude: '(min-width: 48rem)', rules: [{ kind: 'style', selector: '.card:hover', declarations: [{ property: 'transform', value: 'translateY(-2px)' }] }] },
      ], editorRules: [{ kind: 'style', selector: '.card:focus-within', declarations: [{ property: 'outline', value: '2px solid blue' }] }] },
      assets: [{ id: 'photo', source: sourceImage, status: 'ready', destination: 'assets/photo.png', sha256: createHash('sha256').update(image).digest('hex') }, { id: 'logo', source: sourceSvg, status: 'ready', destination: 'assets/logo.svg', sha256: createHash('sha256').update(svg).digest('hex'), uses: [{ node: 'logo', attribute: 'url' }] }, { id: 'body-font', source: sourceFont, kind: 'font', status: 'ready', destination: 'assets/body.woff2', sha256: createHash('sha256').update(font).digest('hex'), fontLicense: { ownership: 'IBM Corp.', license: 'OFL-1.1', notice: fontNotice } }], files: [], warnings: [],
    });
    const plan = await planStandalonePluginOutput(output, { name: 'acme/notice', files: Object.fromEntries([...generated.files, ...generated.assets].map((file) => [file.path, file.content])) });
    await writePluginOutput(plan);
    const lock = JSON.parse(await readFile(path.join(output, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    expect(lock.packages['node_modules/@wordpress/scripts']?.version).toBe('34.2.0');
    await expect(stat(path.join(output, 'node_modules'))).rejects.toThrow();
    const npmEnvironment = await npmEnvironmentForGeneratedPlugin(output);
    await execFileAsync('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: output, timeout: 120_000, env: npmEnvironment });
    await execFileAsync('npm', ['run', 'zip'], { cwd: output, timeout: 120_000, env: { ...npmEnvironment, NODE_ENV: 'production' } });
    const archive = path.join(output, 'acme-notice.zip'); expect(await stat(archive)).toBeTruthy();
    await execFileAsync('npm', ['run', 'test:zip', '--', archive], { cwd: output, timeout: 30_000 });
    const entries = (await execFileAsync('unzip', ['-Z1', archive])).stdout.split(/\r?\n/).filter(Boolean);
    expect(() => assertStandaloneZipEntries(entries, 'notice', ['index.js', 'style-index.css', 'index.css'])).not.toThrow();
    const archiveBytes = async (entry: string): Promise<Buffer> => (await execFileAsync('unzip', ['-p', archive, entry], { encoding: 'buffer', timeout: 10_000 })).stdout;
    const sharedCssPath = entries.find((entry) => entry.endsWith('/blocks/notice/style-index.css'))!;
    const editorCssPath = entries.find((entry) => entry.endsWith('/blocks/notice/index.css'))!;
    const css = (await archiveBytes(sharedCssPath)).toString('utf8');
    expect(css).toContain(':where(.wp-block-acme-notice) .card'); expect(css).toMatch(/@media\s*\(min-width:\s*48rem\)/); expect(css).toContain('translateY(-2px)'); expect(css).not.toContain('./assets/photo.png'); expect(css).not.toContain('focus-within'); expect(css).toContain('@font-face'); expect(css).toContain(fontFamily); expect(css).not.toContain(sourceFont);
    const noticePath = entries.find((entry) => entry.endsWith('/blocks/notice/font-licenses.txt')); expect(noticePath).toBeDefined();
    const notice = (await archiveBytes(noticePath!)).toString('utf8'); expect(notice).toContain('Copyright © 2017 IBM Corp.'); expect(notice).toContain('SIL OPEN FONT LICENSE Version 1.1'); expect(notice).toContain('OTHER DEALINGS IN THE FONT SOFTWARE.'); expect(notice).not.toContain(sourceFont);
    const fonts = entries.filter((entry) => /\/build\/.*\.woff2$/.test(entry)); expect(fonts).toHaveLength(1); expect(await archiveBytes(fonts[0]!)).toEqual(font); expect(css).toContain(path.basename(fonts[0]!)); expect((await archiveBytes(editorCssPath)).toString('utf8')).not.toContain('@font-face'); expect((await archiveBytes(editorCssPath)).toString('utf8')).toContain('.card:focus-within');
    const images = entries.filter((entry) => /\/build\/images\/.*\.png$/.test(entry)); expect(images).toHaveLength(1); expect(await archiveBytes(images[0]!)).toEqual(image); expect(css).toContain(path.basename(images[0]!)); expect(entries.some((entry) => entry.endsWith('.map'))).toBe(false);
    const svgData = /data:image\/svg\+xml(?:;charset=[^;,]+)?(?:;base64)?,[^)"'\s]+/.exec(css)?.[0]; expect(svgData).toBeDefined();
    const [header, payload] = svgData!.split(',', 2); const cssSvg = header!.includes(';base64') ? Buffer.from(payload!, 'base64') : Buffer.from(decodeURIComponent(payload!)); expect(cssSvg.toString()).toContain('viewBox="0 0 80 40"'); expect(cssSvg.toString()).toContain('#123456');
    const script = (await archiveBytes(entries.find((entry) => entry.endsWith('/blocks/notice/index.js'))!)).toString('utf8');
    const svgFiles = entries.filter((entry) => /\/build\/.*\.svg$/.test(entry)); expect(svgFiles).toHaveLength(1); expect(await archiveBytes(svgFiles[0]!)).toEqual(svg); expect(script).toContain(path.basename(svgFiles[0]!)); expect(script).not.toContain('data:image/svg+xml'); expect(script).not.toContain('./assets/logo.svg');
    const existingSource = new Map(await Promise.all([...generated.files, ...generated.assets].map(async (file) => [file.path, await readFile(path.join(output, 'src/blocks/notice', file.path))] as const)));
    const addition = compileRegisteredBlock({ version: 1, generatorVersion: '0.9.0', target: { name: 'acme/second-notice', title: 'Second notice' }, structure: [{ id: 'message', block: 'core/paragraph', attributes: { content: 'An independently registered second block.' } }], fields: [{ id: 'message', node: 'message', attribute: 'content', label: 'Message', mode: 'editable' }], locking: { mode: 'contentOnly' }, styles: { strategy: 'native', outcomes: [] }, pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [] });
    const integration = await planExistingPluginOutput(output, { name: 'acme/second-notice', files: Object.fromEntries(addition.files.map((file) => [file.path, file.content])) }); expect(integration.mode).toBe('existing');
    await writePluginOutput(integration, { authorizedReplacements: integration.touchedFiles.filter((file) => file.operation === 'modify').map((file) => file.path) });
    for (const [relative, bytes] of existingSource) expect(await readFile(path.join(output, 'src/blocks/notice', relative))).toEqual(bytes);
    await execFileAsync('npm', ['run', 'zip'], { cwd: output, timeout: 120_000, env: { ...npmEnvironment, NODE_ENV: 'production' } }); await execFileAsync('npm', ['run', 'test:zip', '--', archive], { cwd: output, timeout: 30_000 });
    const rebuiltEntries = (await execFileAsync('unzip', ['-Z1', archive])).stdout.split(/\r?\n/).filter(Boolean);
    for (const leaf of ['notice', 'second-notice']) { const metadataEntry = rebuiltEntries.find((entry) => entry.endsWith(`/build/blocks/${leaf}/block.json`)); expect(metadataEntry).toBeDefined(); expect(JSON.parse((await archiveBytes(metadataEntry!)).toString('utf8')).name).toBe(`acme/${leaf}`); }
    const manifest = await readFile(path.join(output, 'build/blocks-manifest.php'), 'utf8'); expect(manifest).toContain("'notice'"); expect(manifest).toContain("'second-notice'");
  }, 300_000);
});
