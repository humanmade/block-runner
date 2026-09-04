import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fallbackUnlicensedFonts,
  rewriteCssAssets,
  scanCssUrlReferences,
  scanFontFaces,
  type FontLicenseDecision,
  type PreparedCssAsset,
} from '../src/author/assets.js';
import { collectConfirmedAssets, fontOwnershipDecision } from '../src/authoring/assets.js';
import {
  fontLicenseNoticeFromDecision,
  renderFontLicenseNotice,
  renderLicensedFontFace,
} from '../src/authoring/styles.js';
import { prepareAuthoringFonts } from '../src/author/plan.js';
import { author } from '../src/author/index.js';
import type { AuthoringPlan } from '../src/authoring/schema.js';

const scratch: string[] = [];

afterEach(async () => {
  const directories = scratch.splice(0);
  if (process.platform === 'darwin') {
    await Promise.all(directories.map((directory) => promisify(execFile)('trash', [directory])));
  }
});

async function fixture(extension = '.woff2', bytes = Buffer.from(`${extension === '.woff2' ? 'wOF2' : 'wOFF'}font-fixture`)) {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-fonts-'));
  scratch.push(root);
  const sourcePath = path.join(root, 'design.css');
  const source = path.join(root, `Inter${extension}`);
  await writeFile(sourcePath, '');
  await writeFile(source, bytes);
  return { root, sourcePath, source, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

function decision(reference: string, source: string, hash: string, extra: Partial<FontLicenseDecision> = {}): FontLicenseDecision {
  return {
    reference,
    source,
    sha256: hash,
    ownership: 'Fixture rights holder',
    license: 'OFL-1.1',
    ...extra,
  };
}

describe('registered-block font transport', () => {
  it('copies only an explicitly reviewed local WOFF2 and retains its transport kind', async () => {
    const { sourcePath, source, bytes, hash } = await fixture();
    const prepared: PreparedCssAsset[] = [];
    const result = await rewriteCssAssets({
      sourcePath,
      sourceCss: '@font-face { font-family: Inter; src: url("Inter.woff2") format("woff2"); }',
      destinationAssetDir: path.join(path.dirname(sourcePath), 'package', 'assets'),
      assetUrlPrefix: './assets/',
      prepareAsset: (asset) => prepared.push(asset),
      fontLicenses: [decision('Inter.woff2', source, hash, { notice: 'Keep this notice with the font.' })],
    });

    expect(result.warnings).toEqual([]);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ outcome: 'prepared', kind: 'font', sourceAssetPath: source });
    expect(result.css).toContain('./assets/Inter-');
    expect(result.css).toContain('format("woff2")');
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({ kind: 'font', source, content: bytes, sha256: hash });
  });

  it('does not treat the legacy boolean as a font license and reports the source', async () => {
    const { sourcePath } = await fixture();
    const result = await rewriteCssAssets({
      sourcePath,
      sourceCss: '@font-face{font-family:Inter;src:url(Inter.woff2)}',
      destinationAssetDir: path.join(path.dirname(sourcePath), 'package', 'assets'),
      allowFontLicense: true,
    });

    expect(result.assets[0]).toMatchObject({ outcome: 'unresolved', kind: 'font' });
    expect(result.assets[0]!.reason).toMatch(/not sufficient|reference-bound/i);
    expect(result.warnings[0]).toMatchObject({ reference: 'Inter.woff2', source: expect.objectContaining({ line: 1 }) });
  });

  it.each([
    ['wrong hash', (hash: string) => '0'.repeat(hash.length), 'blocked'],
    ['unsupported format', (hash: string) => hash, 'unresolved'],
  ])('%s cannot cross the font transport boundary', async (_label, hashFor, expected) => {
    const extension = _label === 'unsupported format' ? '.ttf' : '.woff2';
    const { sourcePath, source, hash } = await fixture(extension);
    const result = await rewriteCssAssets({
      sourcePath,
      sourceCss: `@font-face{font-family:Inter;src:url(Inter${extension})}`,
      destinationAssetDir: path.join(path.dirname(sourcePath), 'package', 'assets'),
      fontLicenses: [decision(`Inter${extension}`, source, hashFor(hash))],
    });
    expect(result.assets[0]!.outcome).toBe(expected);
    expect(result.warnings).toHaveLength(1);
  });

  it('rejects remote and data font sources even when a decision is present', async () => {
    const { sourcePath, source, hash } = await fixture();
    const result = await rewriteCssAssets({
      sourcePath,
      sourceCss: '@font-face{font-family:Inter;src:url("https://cdn.example/Inter.woff2"),url(data:font/woff2;base64,wOF2)}',
      destinationAssetDir: path.join(path.dirname(sourcePath), 'package', 'assets'),
      fontLicenses: [
        decision('https://cdn.example/Inter.woff2', source, hash),
        decision('data:font/woff2;base64,wOF2', source, hash),
      ],
    });
    expect(result.assets.map(({ outcome }) => outcome)).toEqual(['unresolved', 'unresolved']);
    expect(result.warnings).toHaveLength(2);
  });

  it('removes an unlicensed face but keeps authored safe fallbacks and warns at the source', () => {
    const css = [
      '@font-face { font-family: "Inter"; src: url(Inter.woff2); }',
      '.card { font-family: "Inter", Arial, sans-serif; }',
      '.title { font: 700 1.25rem "Inter", system-ui, sans-serif; }',
    ].join('\n');
    const result = fallbackUnlicensedFonts(css, { sourcePath: '/design/style.css' });
    expect(result.css).not.toContain('@font-face');
    expect(result.css).toContain('font-family: Arial, sans-serif');
    expect(result.css).toContain('font: 700 1.25rem system-ui, sans-serif');
    expect(result.removedFamilies).toEqual(['Inter']);
    expect(result.rewrittenDeclarations).toBe(2);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]!.source).toMatchObject({ path: '/design/style.css', line: 1 });
  });

  it('preserves a face and declarations only when its family is explicitly approved', () => {
    const css = '@font-face{font-family:Inter;src:url(Inter.woff2)} .card{font-family:Inter,Arial,sans-serif}';
    const result = fallbackUnlicensedFonts(css, { licensedFamilies: ['Inter'] });
    expect(result.css).toBe(css);
    expect(result.warnings).toEqual([]);
    expect(scanFontFaces(css)[0]).toMatchObject({ families: ['Inter'], sourceUrls: ['Inter.woff2'] });
  });

  it('validates generated font faces and preserves a safe redistribution notice', () => {
    const face = renderLicensedFontFace({
      family: 'Inter',
      src: 'url("./assets/Inter-abc123.woff2") format("woff2")',
      fontDisplay: 'swap',
      fontWeight: '100 900',
    });
    expect(face).toContain('@font-face');
    expect(face).toContain('url("./assets/Inter-abc123.woff2")');
    expect(() => renderLicensedFontFace({ family: 'Inter', src: 'url("https://cdn.example/Inter.woff2")' })).toThrow(/package-relative/i);

    const licensed = decision('Inter.woff2', '/design/Inter.woff2', 'a'.repeat(64), { notice: 'Do not remove */ this notice.' });
    const notice = renderFontLicenseNotice([fontLicenseNoticeFromDecision({ families: ['Inter'] }, licensed)]);
    expect(notice.startsWith('/*!')).toBe(true);
    expect(notice).toContain('ownership: Fixture rights holder');
    expect(notice).toContain('license: OFL-1.1');
    expect(notice).toContain('Do not remove * / this notice.');
    expect(notice).toContain('*/');
  });

  it('requires a font ownership/license record in the canonical asset collector', async () => {
    const { source, bytes, hash } = await fixture();
    const asset = {
      id: 'inter', source, destination: 'assets/Inter.woff2', status: 'ready', kind: 'font', sha256: hash,
      fontLicense: { ownership: 'Fixture rights holder', license: 'OFL-1.1' },
    };
    const plan = {
      version: 1, generatorVersion: '0.9.0', target: { name: 'acme/cards', title: 'Cards' },
      structure: [], fields: [], locking: { mode: 'contentOnly' },
      styles: { strategy: 'mixed', outcomes: [], rules: [], fonts: [{ assetId: 'inter', family: 'Inter' }] },
      pattern: { ready: false, overrides: [] }, assets: [asset], files: [], warnings: [],
    } as unknown as AuthoringPlan;
    expect(fontOwnershipDecision(asset as Parameters<typeof fontOwnershipDecision>[0])).toEqual({ ownership: 'Fixture rights holder', license: 'OFL-1.1' });
    const [output] = collectConfirmedAssets(plan);
    expect(output).toMatchObject({ path: 'assets/Inter.woff2', assetKind: 'font', content: bytes, hash });
    await expect(readFile(source)).resolves.toEqual(bytes);
  });

  it('binds shared faces to prepared assets and namespaces families per block', () => {
    const css = '@font-face{font-family:Inter;src:url(Inter.woff2);font-display:swap}.card{font-family:Inter,Arial}';
    const prepared: PreparedCssAsset = {
      source: '/design/Inter.woff2',
      destination: '/package/assets/Inter-abcd.woff2',
      content: Buffer.from('wOF2font'),
      sha256: 'a'.repeat(64),
      kind: 'font',
    };
    const ledger = [{
      reference: 'Inter.woff2', rewritten: './assets/Inter-abcd.woff2', kind: 'font' as const,
      outcome: 'prepared' as const, reason: 'prepared',
    }];
    const first = prepareAuthoringFonts(css, 'acme/card', [prepared], ledger);
    const second = prepareAuthoringFonts(css, 'other/card', [prepared], ledger);
    expect(first.fonts).toEqual([{ assetId: 'asset.0', family: 'block-runner-acme-card-b4f0ba4d-inter', fontDisplay: 'swap' }]);
    expect(first.css).toContain('font-family:block-runner-acme-card-b4f0ba4d-inter,Arial');
    expect(first.css).not.toContain('@font-face');
    expect(first.fonts[0]!.family).not.toBe(second.fonts[0]!.family);
  });

  it('carries an explicitly licensed HTML font through the canonical authoring plan', async () => {
    const { root, sourcePath, source, bytes, hash } = await fixture();
    const css = '@font-face{font-family:Inter;src:url("Inter.woff2") format("woff2");font-display:swap}.copy{font-family:Inter,Arial,sans-serif}';
    const report = await author(`<style>${css}</style><p class="copy">Hello</p>`, {
      sourcePath,
      author: {
        name: 'acme/font-card',
        styles: {
          mode: 'css',
          fontLicenses: [decision('Inter.woff2', source, hash, { notice: 'Retain the OFL notice.' })],
        },
      },
    });

    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect(report.package?.canonicalPlan?.styles.fonts).toEqual([
      expect.objectContaining({
        assetId: 'asset.0',
        family: expect.stringMatching(/^block-runner-acme-font-card-/),
        fontDisplay: 'swap',
      }),
    ]);
    expect(report.package?.files['style.scss']).toContain('/*! Block Runner font redistribution record');
    expect(report.package?.files['style.scss']).toContain('Retain the OFL notice.');
    expect(report.package?.files['style.scss']).toContain('@font-face');
    expect(report.package?.files['style.scss']).toContain('font-family: "block-runner-acme-font-card-');
    expect(report.package?.files['style.scss']).not.toContain(source);
    expect(report.assets).toContainEqual(expect.objectContaining({ reference: 'Inter.woff2', kind: 'font', outcome: 'prepared' }));
    expect(report.package?.assets).toEqual([expect.objectContaining({ path: expect.stringMatching(/^assets\/Inter-/), sha256: hash })]);
    await expect(readFile(path.join(root, 'Inter.woff2'))).resolves.toEqual(bytes);
  });

  it('keeps an unlicensed HTML font usable with a safe fallback and a source warning', async () => {
    const { sourcePath } = await fixture();
    const report = await author(
      '<style>@font-face{font-family:Inter;src:url("Inter.woff2")} .copy{font-family:Inter,Arial,sans-serif}</style><p class="copy">Hello</p>',
      { sourcePath, author: { name: 'acme/font-card', styles: { mode: 'css' } } },
    );

    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect(report.package?.canonicalPlan?.styles.fonts).toBeUndefined();
    expect(report.package?.files['style.scss']).not.toContain('@font-face');
    expect(report.package?.canonicalPlan?.structure[0]?.attributes).toMatchObject({
      style: { typography: { fontFamily: 'Arial, sans-serif' } },
    });
    expect(report.items.some((item) => item.reason.includes('font') && item.reason.includes('licensed'))).toBe(true);
    expect(report.package?.assets ?? []).toEqual([]);
  });

  it('preserves a destination font preset while removing an unrelated unlicensed face', async () => {
    const { sourcePath } = await fixture();
    const report = await author(
      '<style>@font-face{font-family:Inter;src:url("Inter.woff2")} .copy{font-family:Inter, sans-serif}</style><p class="copy">Hello</p>',
      {
        sourcePath,
        config: { tokens: { fonts: { body: 'Inter, sans-serif' } } },
        author: { name: 'acme/font-card', styles: { mode: 'css' } },
      },
    );

    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect(report.package?.canonicalPlan?.styles.fonts).toBeUndefined();
    expect(report.package?.canonicalPlan?.structure[0]?.attributes).toMatchObject({ fontFamily: 'body' });
    expect(report.package?.files['style.scss']).not.toContain('@font-face');
    expect(report.items.some((item) => item.reason.includes('@font-face') && item.reason.includes('licensed'))).toBe(true);
  });
});
