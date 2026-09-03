import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCssUrlReference, rewriteCssAssets, scanCssUrlReferences } from '../src/author/assets.js';
import { author } from '../src/author/index.js';
import { scanStylesheet, scopeStylesheet, validateCssBuildGraph } from '../src/author/styles.js';

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('registered-block stylesheet graph', () => {
  it('keeps responsive, state, and container rules beneath the generated root', () => {
    const scoped = scopeStylesheet(
      scanStylesheet(`
        @media (min-width: 48rem) { .hero:hover { color: rebeccapurple; } }
        @container card (inline-size > 30rem) { .card::before { content: ""; display: block; } }
      `),
      { root: '.wp-block-acme-hero' },
    );

    expect(scoped.css).toContain('@media (min-width: 48rem)');
    expect(scoped.css).toContain('.wp-block-acme-hero .hero:hover');
    expect(scoped.css).toContain('@container card (inline-size > 30rem)');
    expect(scoped.css).toContain('.wp-block-acme-hero .card::before');
    expect(scoped.ledger.every((entry) => entry.outcome === 'scoped-css')).toBe(true);
  });

  it('blocks global foundation and escaping selectors rather than pretending that a prefix preserves them', () => {
    const scoped = scopeStylesheet(
      scanStylesheet(`html, body { margin: 0; } * { box-sizing: border-box; } :root { color: red; } .card { color: blue; }`),
      { root: '.wp-block-acme-hero' },
    );

    expect(scoped.css).toContain('.wp-block-acme-hero .card');
    expect(scoped.css).not.toContain('box-sizing');
    expect(scoped.ledger.filter((entry) => entry.outcome === 'blocked')).toHaveLength(3);
    expect(scoped.ruleRecords.filter((rule) => rule.outcome === 'blocked').map((rule) => rule.reason).join('\n')).toMatch(
      /global|foundation|Preflight/i,
    );
  });

  it('gives declarations inside blocked layers and malformed declarations an explicit ledger outcome', () => {
    const scoped = scopeStylesheet(
      scanStylesheet(`@layer utilities { .card { color: teal; } } .notice { broken; padding: ; }`),
      { root: '.wp-block-acme-hero' },
    );

    expect(scoped.css).toBe('');
    expect(scoped.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'color', outcome: 'blocked' }),
        expect.objectContaining({ property: 'broken', outcome: 'warned' }),
        expect.objectContaining({ property: 'padding', outcome: 'warned' }),
      ]),
    );
  });

  it('lets the caller block a declaration without leaving unsafe residual CSS behind', () => {
    const scoped = scopeStylesheet(scanStylesheet(`.card { behavior: url(widget.htc); color: teal; }`), {
      root: '.wp-block-acme-hero',
      disposition: (declaration) =>
        declaration.property === 'behavior'
          ? { outcome: 'blocked', reason: 'requires executable browser behaviour' }
          : undefined,
    });

    expect(scoped.css).toContain('color: teal');
    expect(scoped.css).not.toContain('behavior');
    expect(scoped.ledger).toContainEqual(expect.objectContaining({ property: 'behavior', outcome: 'blocked' }));
  });

  it('requires the complete explicit Tailwind graph before fidelity can be claimed', () => {
    const missing = validateCssBuildGraph(undefined, { css: '@tailwind utilities;' });
    expect(missing.blocked).toBe(true);
    expect(missing.missing).toEqual([
      'cssEntries',
      'imports',
      'directives',
      'sources',
      'safelist',
      'plugins',
      'environment',
      'browserTarget',
    ]);

    const complete = validateCssBuildGraph(
      {
        cssEntries: ['src/style.css'],
        imports: [],
        directives: ['@tailwind utilities'],
        sources: ['src/**/*.html'],
        safelist: [],
        plugins: [],
        environment: {},
        browserTarget: 'defaults',
      },
      { css: '.utility { --tw-translate-x: 0; transform: translateX(var(--tw-translate-x)); }' },
    );
    expect(complete.complete).toBe(true);
    expect(complete.compiled).toBe(true);
    expect(complete.blocked).toBe(false);

    const incompleteOutput = validateCssBuildGraph(
      {
        cssEntries: ['src/style.css'],
        imports: [],
        directives: ['@tailwind utilities'],
        sources: ['src/**/*.html'],
        safelist: [],
        plugins: [],
        environment: {},
        browserTarget: 'defaults',
      },
      { css: '.utility { transform: translateX(var(--tw-translate-x)); }' },
    );
    expect(incompleteOutput.blocked).toBe(true);
    expect(incompleteOutput.issues.map((issue) => issue.reason).join('\n')).toMatch(/undefined Tailwind variables/i);

    const selfContainedOutput = validateCssBuildGraph(undefined, {
      css: '.utility { --tw-translate-x: 0; transform: translateX(var(--tw-translate-x)); }',
    });
    expect(selfContainedOutput.compiled).toBe(true);
    expect(selfContainedOutput.blocked).toBe(false);
  });
});

describe('registered-block CSS assets', () => {
  it('classifies remote, inline, unsafe, and unlicensed font URLs without fetching them', () => {
    const refs = scanCssUrlReferences(
      `a{background:url(https://cdn.example/a.png)} b{background:url(data:image/png;base64,AA)} c{mask:url(javascript:alert(1))} @font-face{src:url(font.woff2)}`,
      '/design/style.css',
    );
    expect(refs.map((ref) => classifyCssUrlReference(ref, { sourcePath: '/design/style.css' }).outcome)).toEqual([
      'external',
      'external',
      'blocked',
      'unresolved',
    ]);
  });

  it('copies local CSS assets once and rewrites every reference to the package asset', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const design = path.join(directory, 'design.html');
    const sourceAsset = path.join(directory, 'logo.svg');
    const destination = path.join(directory, 'block', 'assets');
    await writeFile(design, '<style></style>');
    await writeFile(sourceAsset, '<svg/>');

    const result = await rewriteCssAssets({
      sourcePath: design,
      sourceCss: `.logo { background-image: url("./logo.svg"); } .again { mask-image: url(./logo.svg); }`,
      destinationAssetDir: destination,
    });

    expect(result.assets.map((asset) => asset.outcome)).toEqual(['copied', 'copied']);
    const [first, second] = result.assets;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.rewrittenUrl).toBe(second!.rewrittenUrl);
    expect(result.css).not.toContain('./logo.svg');
    expect(await readFile(first!.destinationAssetPath!, 'utf8')).toBe('<svg/>');
  });

  it('blocks a relative URL that escapes the stylesheet asset root', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const design = path.join(directory, 'assets', 'design.html');
    const outside = path.join(directory, '.env');
    await mkdir(path.dirname(design), { recursive: true });
    await writeFile(design, '<style></style>');
    await writeFile(outside, 'do-not-copy');

    const reference = scanCssUrlReferences('x{background:url(../.env)}', design)[0]!;
    expect(classifyCssUrlReference(reference, { sourcePath: design })).toMatchObject({ outcome: 'blocked' });
  });
});

describe('registered-block authoring parity ledger', () => {
  it('maps a stylesheet declaration once to a supported native destination without duplicate CSS', async () => {
    const report = await author('<style>.notice { color: red; }</style><p class="notice">Hello</p>', {
      author: { name: 'acme/notice' },
    });

    expect(report.ok).toBe(true);
    expect(report.styleLedger).toContainEqual(expect.objectContaining({ property: 'color', outcome: 'native' }));
    expect(report.package?.files['style.css']).toBeUndefined();
    expect(report.package?.files['index.js']).toContain('"color"');
  });

  it('refuses to write a package after dropping a blocked selector or declaration', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const outDir = path.join(directory, 'package');

    const report = await author('<style>body { color: red; }</style><p>Hello</p>', {
      outDir,
      author: { name: 'acme/notice' },
    });

    expect(report.ok).toBe(false);
    await expect(readFile(path.join(outDir, 'block.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains escaped class, ID, and attribute selector dependencies through native conversion', async () => {
    const report = await author(
      '<style>@media (min-width: 40rem) { .\\32xl\\:open#hero[data-state="open"] { color: red; } }</style><p id="hero" data-state="open" class="2xl:open">Hello</p>',
      { author: { name: 'acme/notice' } },
    );

    expect(report.ok).toBe(true);
    expect(report.package?.files['style.css']).toContain('.\\32xl\\:open.block-runner-selector-id-');
    expect(report.package?.files['index.js']).toContain('"className": "2xl:open block-runner-selector-id-');
    expect(report.package?.files['index.js']).toContain('block-runner-selector-attribute-');
  });

  it('accounts for inline CSS and rewrites srcset assets retained in Custom HTML', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const design = path.join(directory, 'design.html');
    const source = path.join(directory, 'photo.png');
    const outDir = path.join(directory, 'package');
    await writeFile(design, '');
    await writeFile(source, 'photo');

    const report = await author(
      '<p style="color: red">Hello</p><img src="photo.png" srcset="photo.png 1x, photo.png 2x"><div><span style="background-image:image-set(\'photo.png\' 1x)"></span></div>',
      {
      sourcePath: design,
      outDir,
      author: { name: 'acme/notice' },
      },
    );

    expect(report.ok).toBe(true);
    expect(report.styleLedger).toContainEqual(expect.objectContaining({ property: 'color', outcome: 'native' }));
    expect(report.styleLedger).toContainEqual(expect.objectContaining({ property: 'background-image', outcome: 'literal' }));
    expect(report.assets?.filter((asset) => asset.reference === 'photo.png')).toHaveLength(4);
    expect(report.package?.files['index.js']).toContain('srcset=');
    expect(report.package?.files['index.js']).toContain('image-set(');
    expect(await readFile(path.join(outDir, 'block.json'), 'utf8')).toContain('acme/notice');
  });
});
