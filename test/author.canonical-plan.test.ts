import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { author } from '../src/author/index.js';
import { validateCoverageFulfillment } from '../src/author/plan.js';
import { compileRegisteredBlock } from '../src/authoring/generate.js';
import { PROOF_SVG_SOURCE } from '../src/proof/fixture-image.js';

describe('HTML analysis uses the confirmed compiler', () => {
  it('keeps source evidence available when rules cannot propose a tree, then compiles a bound independent plan', async () => {
    const markup = '<custom-card data-layout="masonry"><slot>Ignored by rules</slot></custom-card>';
    const initial = await author(markup, { author: { name: 'example/design' } });

    expect(initial.ok).toBe(false);
    expect(initial.evidence?.structure).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'custom-card', attributes: { 'data-layout': 'masonry' }, source: expect.objectContaining({ offset: 0 }) }),
    ]));
    expect(initial.evidence?.coverage).toBeDefined();

    const result = await author(markup, {
      author: { name: 'example/design' },
      plan: {
        version: 1, generatorVersion: '0.9.0',
        target: { name: 'example/design', title: 'Design', wordpress: '7.1' },
        source: initial.source!, coverage: initial.evidence!.coverage!,
        structure: [{ id: 'root', block: 'core/group', children: [{ id: 'copy', block: 'core/paragraph', attributes: { content: 'Ignored by rules' } }] }],
        fields: [], locking: { mode: 'none' }, styles: { strategy: 'native', outcomes: [] },
        pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [],
      },
    });

    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    expect(result.package?.canonicalPlan?.structure[0]?.block).toBe('core/group');

    const erased = await author(markup, {
      author: { name: 'example/design' },
      plan: { ...result.package!.canonicalPlan!, coverage: { styles: [], assets: [] } },
    });
    expect(erased.ok).toBe(false);
    expect(erased.items.map((item) => item.reason).join('\n')).toMatch(/complete source declaration and asset coverage/i);
  });

  it('returns exact canonical source with responsive CSS, editor CSS, native fields, and SVG transport', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-html-plan-'));
    await writeFile(path.join(root, 'logo.svg'), PROOF_SVG_SOURCE);
    const before = await readdir(root);
    const result = await author('<div class="card"><h2>Heading</h2><img src="logo.svg" alt="A check mark"></div>', {
      sourcePath: path.join(root, 'design.html'), author: { name: 'example/design', locking: { mode: 'contentOnly' },
        styles: { mode: 'css', css: '@media (min-width: 48rem) { .card:hover { transform: translateY(-2px); } }',
          editorCss: '.card:focus-within { outline: 2px solid blue; }' } },
    });
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    const plan = result.package!.canonicalPlan!;
    expect(plan.source).toEqual({
      entry: path.join(root, 'design.html'),
      sha256: createHash('sha256').update('<div class="card"><h2>Heading</h2><img src="logo.svg" alt="A check mark"></div>').digest('hex'),
      format: 'html',
    });
    expect(result.source).toEqual(plan.source);
    expect(plan.coverage?.styles).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'transform', scope: 'shared', outcome: 'scoped-css' }),
      expect.objectContaining({ property: 'outline', scope: 'editor', outcome: 'scoped-css' }),
    ]));
    expect(plan.coverage?.assets).toContainEqual(expect.objectContaining({
      reference: 'logo.svg', outcome: 'prepared', sha256: createHash('sha256').update(PROOF_SVG_SOURCE).digest('hex'),
    }));
    expect(plan.locking.mode).toBe('contentOnly');
    expect(plan.fields).toContainEqual(expect.objectContaining({ attribute: 'alt', mode: 'editable' }));
    const generated = compileRegisteredBlock(plan);
    expect(result.package!.files).toEqual(Object.fromEntries(generated.files.map((file) => [file.path, file.content])));
    expect(result.package!.manifest).toEqual(generated.manifest);
    expect(result.package!.files['style.scss']).toContain('@media (min-width: 48rem)');
    expect(result.package!.files['editor.scss']).toContain('focus-within');
    expect(result.package!.files['asset-urls.mjs']).toContain('new URL(');
    expect(generated.assets[0]!.content.toString()).toBe(PROOF_SVG_SOURCE);
    expect(await readdir(root)).toEqual(before);

    const supplied = await author('<div class="card"><h2>Heading</h2><img src="logo.svg" alt="A check mark"></div>', {
      sourcePath: path.join(root, 'design.html'),
      author: { name: 'example/design', locking: { mode: 'contentOnly' },
        styles: { mode: 'css', css: '@media (min-width: 48rem) { .card:hover { transform: translateY(-2px); } }',
          editorCss: '.card:focus-within { outline: 2px solid blue; }' } },
      plan,
    });
    expect(supplied.ok, JSON.stringify(supplied.items)).toBe(true);
    const missingAsset = structuredClone(plan);
    missingAsset.assets = [];
    const rejectedAsset = await author('<div class="card"><h2>Heading</h2><img src="logo.svg" alt="A check mark"></div>', {
      sourcePath: path.join(root, 'design.html'),
      author: { name: 'example/design', locking: { mode: 'contentOnly' },
        styles: { mode: 'css', css: '@media (min-width: 48rem) { .card:hover { transform: translateY(-2px); } }',
          editorCss: '.card:focus-within { outline: 2px solid blue; }' } },
      plan: missingAsset,
    });
    expect(rejectedAsset.ok).toBe(false);
    expect(rejectedAsset.items.map((item) => item.reason).join('\n')).toMatch(/matching confirmed plan asset record/i);
  });

  it('refuses editor CSS that escapes the component before writing any source', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-html-plan-'));
    const outDir = path.join(root, 'generated');
    const result = await author('<p>Hello</p>', { outDir,
      author: { name: 'example/design', styles: { editorCss: 'body { color:red }' } } });
    expect(result.ok).toBe(false);
    expect(result.package).toBeUndefined();
    expect(result.items.some((item) => item.reason.includes('Editor-only CSS'))).toBe(true);
    await expect(readFile(path.join(outDir, 'block.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds supplied coverage to the requested target and its actual CSS output', async () => {
    const markup = '<custom-card class="notice">Hello</custom-card>';
    const options = { author: { name: 'example/design', styles: { mode: 'css' as const, css: '.notice { color: red; }' } } };
    const analyzed = await author(markup, options);
    expect(analyzed.ok).toBe(false);
    const independent = {
      version: 1 as const, generatorVersion: '0.9.0',
      target: { name: 'example/design', title: 'Design', wordpress: '7.1' },
      source: analyzed.source!, coverage: analyzed.evidence!.coverage!,
      structure: [{ id: 'root', block: 'core/group' }], fields: [], locking: { mode: 'none' as const },
      styles: { strategy: 'scoped-css' as const, outcomes: [], rules: [{ kind: 'style' as const, selector: '.notice', declarations: [{ property: 'color', value: 'red' }] }] },
      pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [],
    };

    // The returned inline coverage contains undefined optional location fields before JSON
    // serialization. A separately validated proposal removes them, but remains equivalent.
    const accepted = await author(markup, { ...options, plan: independent });
    expect(accepted.ok, JSON.stringify(accepted.items)).toBe(true);
    expect(accepted.package?.name).toBe('example/design');
    expect(accepted.package?.files['style.scss']).toContain('color: red');

    const erasedRule = structuredClone(independent);
    erasedRule.styles.rules = [];
    const rejectedCss = await author(markup, { ...options, plan: erasedRule });
    expect(rejectedCss.ok).toBe(false);
    expect(rejectedCss.items.map((item) => item.reason).join('\n')).toMatch(/scoped-css.*matching shared structured CSS rule/i);

    const nativeCoveragePlan: any = structuredClone(independent);
    nativeCoveragePlan.coverage.styles[0].outcome = 'native';
    nativeCoveragePlan.styles = { strategy: 'native', outcomes: [{ property: 'color', value: 'red', outcome: 'native' }] };
    expect(() => validateCoverageFulfillment(nativeCoveragePlan)).toThrow(/marked native.*matching native block attribute/i);

    nativeCoveragePlan.structure[0]!.attributes = { metadata: { color: 'red' } };
    expect(() => validateCoverageFulfillment(nativeCoveragePlan)).toThrow(/matching native block attribute/i);

    nativeCoveragePlan.structure[0]!.attributes = { style: { color: { text: 'red' } } };
    expect(() => validateCoverageFulfillment(nativeCoveragePlan)).not.toThrow();
    expect(compileRegisteredBlock(nativeCoveragePlan).files.find((file) => file.path === 'edit.js')?.content.toString()).toContain('"text": "red"');

    const assertNativeOutput = (property: string, value: string, attributes: object, output: string) => {
      const candidate: any = structuredClone(nativeCoveragePlan);
      candidate.coverage.styles = [{ ...candidate.coverage.styles[0], property, value, outcome: 'native' }];
      candidate.styles = { strategy: 'native', outcomes: [{ property, value, outcome: 'native' }] };
      candidate.structure[0]!.attributes = attributes;
      expect(() => validateCoverageFulfillment(candidate)).not.toThrow();
      expect(compileRegisteredBlock(candidate).files.find((file) => file.path === 'edit.js')?.content.toString()).toContain(output);
    };
    assertNativeOutput('font-size', '2rem', { style: { typography: { fontSize: '2rem' } } }, '"fontSize": "2rem"');
    assertNativeOutput('font-family', 'Inter, sans-serif', { style: { typography: { fontFamily: 'Inter, sans-serif' } } }, '"fontFamily": "Inter, sans-serif"');
    assertNativeOutput('margin-top', '1rem', { style: { spacing: { margin: { top: '1rem' } } } }, '"margin": {');
    assertNativeOutput('line-height', '1.5', { style: { typography: { lineHeight: '1.5' } } }, '"lineHeight": "1.5"');
    assertNativeOutput('border-radius', '4px', { style: { border: { radius: '4px' } } }, '"radius": "4px"');

    const wrongTarget = structuredClone(independent);
    wrongTarget.target.name = 'other/block';
    const rejectedTarget = await author(markup, { ...options, plan: wrongTarget });
    expect(rejectedTarget.ok).toBe(false);
    expect(rejectedTarget.items.map((item) => item.reason).join('\n')).toMatch(/does not match requested block/i);
  });
});
