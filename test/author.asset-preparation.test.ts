import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteCssAssets, type PreparedCssAsset } from '../src/author/assets.js';
import { author } from '../src/author/index.js';
import { PROOF_IMAGE_BASE64 } from '../src/proof/fixture-image.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-prepared-assets-'));
  const image = Buffer.from(PROOF_IMAGE_BASE64, 'base64');
  const sourcePath = path.join(root, 'design.html');
  await writeFile(sourcePath, '');
  await writeFile(path.join(root, 'photo.png'), image);
  return { root, image, sourcePath, outDir: path.join(root, 'package') };
}

describe('asset preparation before package publication', () => {
  it('collects local bytes once without creating the destination', async () => {
    const { root, image, sourcePath, outDir } = await fixture();
    const prepared: PreparedCssAsset[] = [];
    const result = await rewriteCssAssets({
      sourceCss: '.one { background: url(photo.png) } .two { background: url(photo.png#view) }',
      sourcePath,
      destinationAssetDir: path.join(outDir, 'assets'),
      assetUrlPrefix: './assets/',
      prepareAsset: (asset) => prepared.push(asset),
    });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      source: path.join(root, 'photo.png'), content: image,
      sha256: createHash('sha256').update(image).digest('hex'),
    });
    expect(result.assets.map(({ outcome }) => outcome)).toEqual(['prepared', 'prepared']);
    expect(result.css).toContain('./assets/');
    expect(result.css).toContain('#view');
    await expect(lstat(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prepares an HTML design read-only with a hash-bound asset manifest', async () => {
    const { root, image, sourcePath } = await fixture();
    const before = await readdir(root);
    const report = await author('<p>Example</p><img src="photo.png" alt="Product">', {
      sourcePath, author: { name: 'acme/asset-preview' },
    });
    expect(report.ok).toBe(true);
    expect(report.assets).toContainEqual(expect.objectContaining({ reference: 'photo.png', outcome: 'prepared' }));
    expect(report.package?.assets).toEqual([expect.objectContaining({
      source: path.join(root, 'photo.png'), path: expect.stringMatching(/^assets\/photo-/),
      sha256: createHash('sha256').update(image).digest('hex'),
    })]);
    expect(await readdir(root)).toEqual(before);
  });

  it('does not publish an earlier valid asset when a later asset is missing', async () => {
    const { sourcePath, outDir } = await fixture();
    const report = await author('<img src="photo.png" alt="Product"><img src="missing.png" alt="Missing">', {
      sourcePath, outDir, author: { name: 'acme/asset-preview' },
    });
    expect(report.ok).toBe(false);
    expect(report.assets).toContainEqual(expect.objectContaining({ reference: 'photo.png', outcome: 'prepared' }));
    expect(report.assets).toContainEqual(expect.objectContaining({ reference: 'missing.png', outcome: 'unresolved' }));
    await expect(lstat(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes validated source and assets together with exact binary bytes', async () => {
    const { image, sourcePath, outDir } = await fixture();
    const report = await author('<img src="photo.png" alt="Product">', {
      sourcePath, outDir, author: { name: 'acme/asset-preview' },
    });
    expect(report.ok).toBe(true);
    expect(report.assets?.every(({ outcome }) => outcome === 'copied')).toBe(true);
    expect(await readFile(path.join(outDir, report.package!.assets![0]!.path))).toEqual(image);
    expect(await readFile(path.join(outDir, 'block.json'), 'utf8')).toBe(report.package!.files['block.json']);
  });

  it('preserves a colliding source file without publishing prepared assets', async () => {
    const { sourcePath, outDir } = await fixture();
    await mkdir(outDir);
    await writeFile(path.join(outDir, 'block.json'), 'user-owned');
    await expect(author('<img src="photo.png" alt="Product">', {
      sourcePath, outDir, author: { name: 'acme/asset-preview' },
    })).rejects.toThrow(/already exists/);
    expect(await readFile(path.join(outDir, 'block.json'), 'utf8')).toBe('user-owned');
    expect(await readdir(outDir)).toEqual(['block.json']);
  });

  it('rejects a linked destination without writing through it', async () => {
    const { root, sourcePath, outDir } = await fixture();
    const protectedDir = path.join(root, 'protected');
    await mkdir(protectedDir);
    await symlink(protectedDir, outDir);
    await expect(author('<img src="photo.png" alt="Product">', {
      sourcePath, outDir, author: { name: 'acme/asset-preview' },
    })).rejects.toThrow(/symbolic|symlink|link/i);
    expect(await readdir(protectedDir)).toEqual([]);
  });
});
