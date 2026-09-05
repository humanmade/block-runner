import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertStaticSvg } from '../src/authoring/svg.js';
import { compileRegisteredBlock, planRegisteredBlockOutput } from '../src/authoring/generate.js';
import type { AuthoringPlan } from '../src/authoring/schema.js';

const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40">${body}</svg>`;
const valid = wrap('<defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#00f"/></linearGradient><path id="shape" d="M0 0h80v40H0z"/></defs><style>.paint { fill: url(#paint); stroke: none }</style><use href="#shape" class="paint"/><text x="2" y="20" aria-label="Name">Logo</text>');

describe('confirmed static SVG assets', () => {
  it('accepts static geometry, text, styles, gradients, and local references without rewriting bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-svg-'));
    const source = path.join(root, 'logo.svg');
    const bytes = Buffer.from(valid);
    await writeFile(source, bytes);
    const plan: AuthoringPlan = {
      version: 1, generatorVersion: '0.9.0', target: { name: 'acme/logo', title: 'Logo' },
      structure: [{ id: 'logo', block: 'core/image', attributes: { alt: 'Logo' } }],
      fields: [], locking: { mode: 'contentOnly' }, styles: { strategy: 'native', outcomes: [] },
      pattern: { ready: false, overrides: [] }, files: [], warnings: [],
      assets: [{ id: 'logo', source, destination: 'assets/logo.svg', status: 'ready',
        sha256: createHash('sha256').update(bytes).digest('hex'), uses: [{ node: 'logo', attribute: 'url' }] }],
    };
    expect(planRegisteredBlockOutput(plan).files).toContainEqual({ path: 'assets/logo.svg', operation: 'create' });
    expect(planRegisteredBlockOutput(plan).files).toContainEqual({ path: 'asset-urls.mjs', operation: 'create' });
    const generated = compileRegisteredBlock(plan);
    expect(generated.assets[0]!.content).toEqual(bytes);
    expect(generated.files.find(({ path }) => path === 'edit.js')!.content).toContain("import { asset0 } from './asset-urls.mjs'");
    expect(generated.files.find(({ path }) => path === 'asset-urls.mjs')!.content).toContain('new URL("./assets/logo.svg", import.meta.url).href');
    expect(generated.manifest.files).toContainEqual(expect.objectContaining({ path: 'asset-urls.mjs', kind: 'javascript' }));
    expect(generated.template[0]![1]).not.toHaveProperty('id');
    const cssOnly = structuredClone(plan);
    cssOnly.structure = [{ block: 'core/group', attributes: { className: 'logo' } }];
    cssOnly.assets[0]!.uses = [];
    cssOnly.styles.rules = [{ kind: 'style', selector: '.logo', declarations: [{ property: 'background-image', value: 'url("./assets/logo.svg")' }] }];
    const cssGenerated = compileRegisteredBlock(cssOnly);
    expect(cssGenerated.files.some(({ path }) => path === 'asset-urls.mjs')).toBe(false);
    expect(cssGenerated.files.find(({ path }) => path === 'edit.js')!.content).not.toContain('import asset');
    await writeFile(source, wrap('<script>alert(1)</script>'));
    expect(() => planRegisteredBlockOutput(plan)).toThrow('changed since confirmation');
  });

  it.each([
    '<script>alert(1)</script>', '<foreignObject><div>HTML</div></foreignObject>',
    '<rect onload="alert(1)"/>', '<animate attributeName="href" values="javascript:alert(1)"/>',
    '<image href="https://example.com/unconfirmed.png"/>', '<use href="other.svg#part"/>',
    '<use href="#missing"/>', '<g id="same"/><path id="same"/>',
    '<path fill="url(https://example.com/paint.svg#paint)"/>',
    '<style>@import "https://example.com/global.css";</style>',
    '<style>.x { behavior: url(x) }</style>', '<style>.x { & .y { fill:red } }</style>',
    '<rect style="fill:red } body { color:blue"/>', '<rect style="fill:expression(alert(1))"/>',
    '<rect style="fill:url(\\68ttps://example.com/asset)"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>',
  ])('refuses unsafe or unresolved content instead of sanitizing it: %s', (body) => {
    expect(() => assertStaticSvg(Buffer.from(wrap(body)), 'logo.svg')).toThrow('unsupported SVG');
  });

  it.each([
    '<!DOCTYPE svg [<!ENTITY text "hidden">]>' + wrap('<text>&text;</text>'),
    '<?xml-stylesheet href="https://example.com/xsl"?>' + wrap(''),
    '<svg><path></svg>', '<html xmlns="http://www.w3.org/1999/xhtml"/>',
  ])('refuses document indirection or malformed XML', (xml) => {
    expect(() => assertStaticSvg(Buffer.from(xml), 'logo.svg')).toThrow('unsupported SVG');
  });
});
