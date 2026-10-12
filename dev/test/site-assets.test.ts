import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSiteThemeAssets } from '../../src/site/assets.js';
import { prepareSiteSource } from '../../src/site/input.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent', import.meta.url));
const intentPath = fileURLToPath(new URL('./fixtures/site-intent/site.intent.json', import.meta.url));

async function setup() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-site-assets-'));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

describe('site theme assets', () => {
  it('rewrites only declared stylesheet URLs and loads styles in the editor and frontend', async () => {
    const root = await setup();
    try {
      const intent = JSON.parse(await readFile(intentPath, 'utf8')) as any;
      intent.assets.push({ id: 'brand-image', path: 'media/brand.png', kind: 'image', role: 'theme-file' });
      await mkdir(path.join(root, 'media'), { recursive: true });
      await writeFile(path.join(root, 'media/brand.png'), await readFile(path.join(root, 'media/hero.png')));
      await writeFile(path.join(root, 'styles/site.css'), '.brand { background: url("brand.png") center; }');
      intent.assets[1].cssUrls = [{ url: 'brand.png', assetId: 'brand-image' }];
      const prepared = await prepareSiteSource(intent, root);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = buildSiteThemeAssets(prepared.source);
      expect(result.diagnostics).toEqual([]);
      expect(Buffer.from(result.files.find(({ path: filePath }) => filePath === 'assets/styles/site.css')!.bytes).toString())
        .toBe('.brand { background: url("../media/brand.png") center; }');
      expect(result.files.map(({ path: filePath }) => filePath)).toEqual(['assets/media/brand.png', 'assets/styles/site.css', 'functions.php']);
      const bootstrap = Buffer.from(result.files.find(({ path: filePath }) => filePath === 'functions.php')!.bytes).toString();
      expect(bootstrap).toContain("wp_enqueue_style('block-runner-site-0', get_theme_file_uri('assets/styles/site.css')");
      expect(bootstrap).toContain("add_theme_support('editor-styles');");
      expect(bootstrap).toContain("add_editor_style('assets/styles/site.css')");
      expect(bootstrap).not.toContain('wp-content/themes');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps font ownership, license and supplied notice beside the exact font bytes', async () => {
    const root = await setup();
    try {
      const intent = JSON.parse(await readFile(intentPath, 'utf8')) as any;
      intent.assets.push({ id: 'licensed-font', path: 'fonts/IBMPlexMono-Regular.woff2', kind: 'font', role: 'theme-file',
        fontLicense: { ownership: 'OFL redistribution approved', license: 'OFL-1.1', notice: 'Copyright 2026 Example' } });
      await mkdir(path.join(root, 'fonts'), { recursive: true });
      const bytes = await readFile(new URL('./fixtures/fonts/IBMPlexMono-Regular.woff2', import.meta.url));
      await writeFile(path.join(root, 'fonts/IBMPlexMono-Regular.woff2'), bytes);
      const prepared = await prepareSiteSource(intent, root);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = buildSiteThemeAssets(prepared.source);
      expect(result.diagnostics).toEqual([]);
      expect(Buffer.from(result.files.find(({ path: filePath }) => filePath === 'assets/fonts/IBMPlexMono-Regular.woff2')!.bytes)).toEqual(bytes);
      expect(Buffer.from(result.files.find(({ path: filePath }) => filePath.endsWith('.LICENSE.txt'))!.bytes).toString())
        .toBe('Ownership: OFL redistribution approved\nLicense: OFL-1.1\n\nCopyright 2026 Example\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects undeclared CSS dependencies and emits no bootstrap when no stylesheet exists', async () => {
    const root = await setup();
    try {
      const intent = JSON.parse(await readFile(intentPath, 'utf8')) as any;
      await writeFile(path.join(root, 'styles/site.css'), '.hero { background: url(https://example.test/hero.png); }');
      const prepared = await prepareSiteSource(intent, root);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = buildSiteThemeAssets(prepared.source);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'undeclared-css-url' }));
      expect(result.files.some(({ path: filePath }) => filePath === 'functions.php')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses quoted and url-form CSS @import dependencies', async () => {
    for (const importRule of ['@import "nested.css";', '@import url("nested.css");']) {
      const root = await setup();
      try {
        const intent = JSON.parse(await readFile(intentPath, 'utf8')) as any;
        await writeFile(path.join(root, 'styles/site.css'), `${importRule}\n:root { color: black; }`);
        const prepared = await prepareSiteSource(intent, root);
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) continue;

        const result = buildSiteThemeAssets(prepared.source);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'css-import-unsupported' }));
        expect(result.files.some(({ path: filePath }) => filePath === 'assets/styles/site.css')).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('requires theme.json file references to match exact emitted theme asset paths', async () => {
    const root = await setup();
    try {
      const intent = JSON.parse(await readFile(intentPath, 'utf8')) as any;
      intent.theme.themeJson.validationCases = [
        'file:./assets/styles/site.css',
        'file:./assets/missing.woff2',
        'file:./assets/../outside.woff2',
        'file:../outside.woff2',
      ];
      const prepared = await prepareSiteSource(intent, root);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = buildSiteThemeAssets(prepared.source);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/theme/themeJson/validationCases/1', code: 'undeclared-theme-json-file-reference' }),
        expect.objectContaining({ path: '/theme/themeJson/validationCases/2', code: 'unsafe-theme-json-file-reference' }),
        expect.objectContaining({ path: '/theme/themeJson/validationCases/3', code: 'unsafe-theme-json-file-reference' }),
      ]));
      expect(result.diagnostics.some(({ path: diagnosticPath }) => diagnosticPath.endsWith('/validationCases/0'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not generate executable PHP when a site declares no theme stylesheet', async () => {
    const root = await setup();
    try {
      const intent = JSON.parse(await readFile(intentPath, 'utf8')) as any;
      intent.assets = intent.assets.filter((asset: { role: string }) => asset.role === 'attachment');
      const prepared = await prepareSiteSource(intent, root);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = buildSiteThemeAssets(prepared.source);
      expect(result.diagnostics).toEqual([]);
      expect(result.files).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses unlicensed fonts and CSS declarations aimed at attachment assets', async () => {
    const intent = JSON.parse(await readFile(intentPath, 'utf8')) as any;
    intent.assets.push({ id: 'font', path: 'fonts/font.woff2', kind: 'font', role: 'theme-file' });
    intent.assets[1].cssUrls = [{ url: 'hero.png', assetId: 'home-hero' }];
    const diagnostics: Array<{ path: string; code: string }> = [];
    const { validateSiteIntent } = await import('../../src/site/input.js');
    validateSiteIntent(intent, diagnostics as any);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/assets/2/fontLicense', code: 'font-license-required' }),
      expect.objectContaining({ path: '/assets/1/cssUrls/0/assetId', code: 'theme-file-required' }),
    ]));
  });
});
