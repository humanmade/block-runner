import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileRegisteredBlock, planRegisteredBlockOutput, registeredBlockFontFamilyPrefix } from '../src/authoring/generate.js';
import type { AuthoringPlan } from '../src/authoring/schema.js';

async function fontFixture(family = 'block-runner-acme-policy-8ff93569-acme-policy-inter') {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-font-generation-'));
  // The package boundary checks the WOFF signature and the confirmed hash; a full font parser is
  // intentionally outside this deterministic source-emitter test.
  const bytes = Buffer.from('wOF2\x00\x00\x00\x00font-test');
  const source = path.join(root, 'inter.woff2');
  await writeFile(source, bytes);
  const plan: AuthoringPlan = {
    version: 1,
    generatorVersion: '0.9.0',
    target: { name: 'acme/policy', title: 'Policy' },
    structure: [{ block: 'core/paragraph', attributes: { content: 'Text' } }],
    fields: [],
    locking: { mode: 'none' },
    styles: {
      strategy: 'mixed',
      outcomes: [],
      fonts: [{ assetId: 'font.inter', family, fontWeight: '400', fontDisplay: 'swap' }],
    },
    pattern: { ready: false, overrides: [] },
    assets: [{
      id: 'font.inter',
      source,
      kind: 'font',
      destination: 'assets/inter.woff2',
      status: 'ready',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fontLicense: { ownership: 'Acme', license: 'OFL-1.1', notice: 'See */\nlicense file' },
    }],
    files: [],
    warnings: [],
  };
  return { root, source, plan };
}

describe('registered-block font generation', () => {
  it('emits confirmed faces and an escaped, package-relative redistribution record in shared CSS', async () => {
    const { root, source, plan } = await fontFixture();
    const generated = compileRegisteredBlock(plan);
    const style = generated.files.find((file) => file.path === 'style.scss')!.content;
    const editor = generated.files.find((file) => file.path === 'editor.scss')!.content;
    const licenseText = generated.files.find((file) => file.path === 'font-licenses.txt')!;

    expect(style).toContain('/*! Block Runner font redistribution record');
    expect(style).toContain('family: block-runner-acme-policy-8ff93569-acme-policy-inter');
    expect(style).toContain('source: ./assets/inter.woff2');
    expect(style).toContain('ownership: Acme');
    expect(style).toContain('license: OFL-1.1');
    expect(style).toContain('notice: See * / license file');
    expect(style).toContain('@font-face { font-family: "block-runner-acme-policy-8ff93569-acme-policy-inter"; src: url("./assets/inter.woff2"); font-weight: 400; font-display: swap; }');
    expect(style).not.toContain(source);
    expect(editor).not.toContain('@font-face');
    expect(licenseText.kind).toBe('text');
    expect(licenseText.content).toContain('Block Runner bundled font licenses');
    expect(licenseText.content).toContain('Family: block-runner-acme-policy-8ff93569-acme-policy-inter');
    expect(licenseText.content).toContain('Source: ./assets/inter.woff2');
    expect(licenseText.content).toContain('Ownership: Acme');
    expect(licenseText.content).toContain('License: OFL-1.1');
    expect(licenseText.content).toContain('Notice:\nSee */\nlicense file');
    expect(licenseText.content).not.toContain(source);
    expect(generated.manifest.files).toContainEqual(expect.objectContaining({ path: 'assets/inter.woff2', kind: 'asset' }));
    expect(generated.manifest.files).toContainEqual(expect.objectContaining({ path: 'font-licenses.txt', kind: 'text', contentHash: licenseText.hash }));
    expect(planRegisteredBlockOutput(plan).files).toContainEqual({ path: 'assets/inter.woff2', operation: 'create' });
    expect(planRegisteredBlockOutput(plan).files).toContainEqual({ path: 'font-licenses.txt', operation: 'create' });
    expect(registeredBlockFontFamilyPrefix(plan.target.name)).toBe('block-runner-acme-policy-8ff93569-');

    // The source path stays available to the confirmation plan but is not published in CSS.
    await expect(readFile(path.join(root, 'inter.woff2'))).resolves.toEqual(Buffer.from('wOF2\x00\x00\x00\x00font-test'));
  });

  it('rejects a global family name before preview or generation', async () => {
    const { plan } = await fontFixture('Inter');
    expect(() => planRegisteredBlockOutput(plan)).toThrow('unsafe-font-family');
    expect(() => compileRegisteredBlock(plan)).toThrow('unsafe-font-family');
  });

  it('requires every bundled font to have a face and explicit license decision', async () => {
    const { plan } = await fontFixture();
    plan.styles.fonts = [];
    expect(() => compileRegisteredBlock(plan)).toThrow('must be referenced by a confirmed styles.fonts face');

    const withMissingLicense = await fontFixture();
    withMissingLicense.plan.assets[0]!.fontLicense = undefined;
    expect(() => compileRegisteredBlock(withMissingLicense.plan)).toThrow('ownership and license decision');
  });

  it('rejects a bundled font whose face does not confirm that asset id', async () => {
    const { plan } = await fontFixture();
    plan.styles.fonts = [{ assetId: 'missing', family: 'block-runner-acme-policy-8ff93569-acme-policy-inter' }];
    expect(() => planRegisteredBlockOutput(plan)).toThrow('must reference an asset in $.assets');
  });
});
