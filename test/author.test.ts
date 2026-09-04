import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCssUrlReference, rewriteCssAssets, scanCssUrlReferences } from '../src/author/assets.js';
import { author } from '../src/author/index.js';
import { PROOF_IMAGE_BASE64 } from '../src/proof/fixture-image.js';
import {
  compileTailwindBuildGraph,
  createSelectorDependencyTransport,
  scanStylesheet,
  scopeStylesheet,
  validateCssBuildGraph,
} from '../src/author/styles.js';

const scratch: string[] = [];

afterEach(async () => {
  // Preserve generated scratch files recoverably; never recursively delete a directory.
  const directories = scratch.splice(0);
  // CI containers dispose of their temporary filesystem outside the test process.
  if (process.platform === 'darwin') {
    await Promise.all(directories.map((directory) => promisify(execFile)('trash', [directory])));
  }
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
    const missing = validateCssBuildGraph(undefined, { css: '@tailwind utilities;', tailwindDetected: true });
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
      'compiler',
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
        compiler: { name: 'tailwindcss', version: '3.4.0', compile: () => '' },
      },
      { css: '.utility { --tw-translate-x: 0; transform: translateX(var(--tw-translate-x)); }' },
    );
    expect(complete.complete).toBe(true);
    expect(complete.compiled).toBe(true);
    expect(complete.blocked).toBe(true);
    expect(complete.provenanceVerified).toBe(false);

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
        compiler: { name: 'tailwindcss', version: '3.4.0', compile: () => '' },
      },
      { css: '.utility { transform: translateX(var(--tw-translate-x)); }' },
    );
    expect(incompleteOutput.blocked).toBe(true);
    expect(incompleteOutput.issues.map((issue) => issue.reason).join('\n')).toMatch(/undefined Tailwind variables/i);

    const selfContainedOutput = validateCssBuildGraph(undefined, {
      css: '.utility { --tw-translate-x: 0; transform: translateX(var(--tw-translate-x)); }',
      tailwindDetected: true,
    });
    expect(selfContainedOutput.compiled).toBe(true);
    expect(selfContainedOutput.blocked).toBe(true);
  });

  it('uses the supplied pinned compiler and rejects CSS that is not its output', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    await writeFile(path.join(directory, 'design.html'), '');
    await writeFile(path.join(directory, 'style.css'), '@tailwind utilities;');
    const compiler = {
      name: 'tailwindcss',
      version: '3.4.0',
      compile: (input: { cssEntries: ReadonlyArray<{ path: string; css: string }> }) => {
        expect(input.cssEntries[0]?.css).toBe('@tailwind utilities;');
        return '.notice { color: red; }';
      },
    };
    const graph = {
      cssEntries: ['style.css'],
      imports: [],
      directives: ['@tailwind utilities'],
      sources: ['design.html'],
      safelist: [],
      plugins: [],
      environment: {},
      browserTarget: 'defaults',
      compiler,
    };

    const compiled = await compileTailwindBuildGraph(graph, { sourcePath: path.join(directory, 'design.html') });
    expect(compiled).toMatchObject({ css: '.notice { color: red; }', verified: true, issues: [] });

    const authoredFromSource = await author('<style>@tailwind utilities;</style><p class="notice">Hello</p>', {
      sourcePath: path.join(directory, 'design.html'),
      author: { name: 'acme/notice', styles: { mode: 'tailwind', tailwind: graph } },
    });
    expect(authoredFromSource.ok).toBe(true);
    expect(authoredFromSource.package?.files['edit.js']).toContain('"text": "red"');

    const rejected = await author('<p class="notice">Hello</p>', {
      sourcePath: path.join(directory, 'design.html'),
      author: { name: 'acme/notice', styles: { mode: 'tailwind', css: '.notice { color: blue; }', tailwind: graph } },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.items.map((item) => item.reason).join('\n')).toMatch(/does not match output from pinned Tailwind compiler/i);
  });

  it('reports undeclared custom variants and plugins from the materialized source graph', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    await writeFile(
      path.join(directory, 'style.css'),
      '@tailwind utilities; @custom-variant night (&:where(.night, .night *)); @plugin "tailwind-motion";',
    );
    const result = await compileTailwindBuildGraph({
      cssEntries: ['style.css'],
      imports: [],
      directives: ['@tailwind utilities'],
      sources: ['design.html'],
      safelist: [],
      plugins: [],
      environment: {},
      browserTarget: 'defaults',
      compiler: { name: 'tailwindcss', version: '4.0.0', compile: () => '.x {}' },
    }, { sourcePath: path.join(directory, 'design.html') });

    expect(result.verified).toBe(false);
    expect(result.issues.map((issue) => issue.reason).join('\n')).toMatch(/custom-variant night|Tailwind plugin tailwind-motion/i);
  });

  it('requires an explicit stylesheet mode before accepting compiled CSS without Tailwind tokens', async () => {
    const anonymous = await author('<style>.p-4 { padding: 1rem; }</style><p class="p-4">Hello</p>', {
      author: { name: 'acme/padding' },
    });
    expect(anonymous.ok).toBe(false);
    expect(anonymous.items.map((item) => item.reason).join('\n')).toMatch(/styles\.mode.*css.*tailwind/i);

    const unprovenTailwind = await author('<style>.p-4 { padding: 1rem; }</style><p class="p-4">Hello</p>', {
      author: { name: 'acme/padding', styles: { mode: 'tailwind' } },
    });
    expect(unprovenTailwind.ok).toBe(false);
    expect(unprovenTailwind.items.map((item) => item.reason).join('\n')).toMatch(/pinned Tailwind compiler/i);
  });

  it('requires every local, package, and remote CSS import to be materialized', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    await writeFile(path.join(directory, 'style.css'), '@import "tailwindcss"; @import url("https://cdn.example/theme.css");');

    const result = await compileTailwindBuildGraph({
      cssEntries: ['style.css'],
      imports: [],
      directives: [],
      sources: ['design.html'],
      safelist: [],
      plugins: [],
      environment: {},
      browserTarget: 'defaults',
      compiler: { name: 'tailwindcss', version: '4.0.0', compile: () => '.p-4 { padding: 1rem; }' },
    }, { sourcePath: path.join(directory, 'design.html') });

    expect(result.verified).toBe(false);
    expect(result.issues.map((issue) => issue.reason).join('\n')).toMatch(/tailwindcss.*not materialized|https:\/\/cdn\.example.*not materialized/i);
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

  it('reads only image positions from image-set(), not quoted type descriptors', () => {
    const refs = scanCssUrlReferences(
      'x { background-image: image-set("photo.avif" 1x type("image/avif"), url("photo.png") 2x type("image/png")); }',
    );
    expect(refs.map((reference) => reference.url)).toEqual(['photo.avif', 'photo.png']);
  });
});

describe('registered-block authoring parity ledger', () => {
  it('maps a stylesheet declaration once to a supported native destination without duplicate CSS', async () => {
    const report = await author('<style>.notice { color: red; }</style><p class="notice">Hello</p>', {
      author: { name: 'acme/notice', styles: { mode: 'css' } },
    });

    expect(report.ok).toBe(true);
    expect(report.styleLedger).toContainEqual(expect.objectContaining({ property: 'color', outcome: 'native' }));
    expect(report.package?.files['style.scss']).not.toContain('color:');
    expect(report.package?.files['edit.js']).toContain('"color"');
  });

  it('refuses to write a package after dropping a blocked selector or declaration', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const outDir = path.join(directory, 'package');

    const report = await author('<style>body { color: red; }</style><p>Hello</p>', {
      outDir,
      author: { name: 'acme/notice', styles: { mode: 'css' } },
    });

    expect(report.ok).toBe(false);
    await expect(readFile(path.join(outDir, 'block.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains escaped class, ID, and attribute selector dependencies through native conversion', async () => {
    const report = await author(
      '<style>@media (min-width: 40rem) { .\\32xl\\:open#hero[data-state="open"] { color: red; } }</style><p id="hero" data-state="open" class="2xl:open">Hello</p>',
      { author: { name: 'acme/notice', styles: { mode: 'css' } } },
    );

    expect(report.ok).toBe(true);
    expect(report.package?.files['style.scss']).toContain('.\\32xl\\:open:is(#hero, .block-runner-selector-id-');
    expect(report.package?.files['edit.js']).toContain('"className": "2xl:open block-runner-selector-id-');
    expect(report.package?.files['edit.js']).toContain('block-runner-selector-attribute-');
  });

  it('preserves stylesheet ownership when one selector maps natively for only some matching elements', async () => {
    const report = await author(
      '<style>.notice { color: red; }</style><p class="notice">Outer <span class="notice">inner</span></p>',
      { author: { name: 'acme/notice', styles: { mode: 'css' } } },
    );

    expect(report.ok).toBe(true);
    expect(report.styleLedger?.filter((entry) => entry.property === 'color')).toEqual([
      expect.objectContaining({ outcome: 'scoped-css' }),
    ]);
    expect(report.package?.files['style.scss']).toContain('.wp-block-acme-notice .notice { color: red; }');
    expect(report.package?.files['edit.js']).not.toContain('"color": "red"');
  });

  it('keeps an identical conditional declaration in residual CSS instead of aliasing a native top-level rule', async () => {
    const report = await author(
      '<style>.notice { color: red; } @media (min-width: 40rem) { .notice { color: red; } }</style><p class="notice">Hello</p>',
      { author: { name: 'acme/notice', styles: { mode: 'css' } } },
    );

    expect(report.ok).toBe(true);
    expect(report.styleLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'color', outcome: 'native', atRules: [] }),
      expect.objectContaining({ property: 'color', outcome: 'scoped-css', atRules: ['@media (min-width: 40rem)'] }),
    ]));
    expect(report.package?.files['style.scss']).toContain('@media (min-width: 40rem)');
    expect(report.package?.files['style.scss']).toContain('.wp-block-acme-notice .notice { color: red; }');
  });

  it('suppresses rewritten mixed declarations with the same identity used by final conversion', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const design = path.join(directory, 'design.html');
    const outDir = path.join(directory, 'package');
    await writeFile(design, '');
    await writeFile(path.join(directory, 'photo.png'), Buffer.from(PROOF_IMAGE_BASE64, 'base64'));

    const report = await author(
      '<style>.notice { background-image: url("photo.png"); }</style><div class="notice"><p>Hero</p></div><p><span class="notice">Fallback</span></p>',
      { sourcePath: design, outDir, author: { name: 'acme/notice', styles: { mode: 'css' } } },
    );

    expect(report.ok).toBe(true);
    expect(report.styleLedger).toContainEqual(expect.objectContaining({ property: 'background-image', outcome: 'scoped-css' }));
    expect(report.package?.files['style.scss']).toContain('./assets/');
    expect(report.package?.files['edit.js']).not.toContain('"url": "./assets/');
  });

  it('blocks invalid attribute selectors before emitting a marker dependency and retains ID specificity', () => {
    const transport = createSelectorDependencyTransport();
    const idScoped = scopeStylesheet(scanStylesheet('#hero { color: red; }'), {
      root: '.wp-block-acme-notice',
      selectorTransform: transport.rewrite,
    });
    expect(idScoped.css).toContain(':is(#hero, .block-runner-selector-id-');

    const invalidTransport = createSelectorDependencyTransport();
    const invalid = scopeStylesheet(scanStylesheet('[data-state=] { color: red; }'), {
      root: '.wp-block-acme-notice',
      selectorTransform: invalidTransport.rewrite,
    });
    expect(invalid.css).toBe('');
    expect(invalid.ledger).toContainEqual(expect.objectContaining({ outcome: 'blocked', reason: expect.stringMatching(/invalid attribute selector/i) }));
    expect(invalidTransport.dependencies).toEqual([]);
  });

  it('retains the inline CSS and srcset ledger but refuses unresolved Custom HTML source', async () => {
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

    expect(report.ok).toBe(false);
    expect(report.items.some((item) => item.reason.includes('Unresolved native structure'))).toBe(true);
    expect(report.styleLedger).toContainEqual(expect.objectContaining({ property: 'color', outcome: 'native' }));
    expect(report.styleLedger).toContainEqual(expect.objectContaining({ property: 'background-image', outcome: 'literal' }));
    expect(report.assets?.filter((asset) => asset.reference === 'photo.png')).toHaveLength(4);
    expect(report.package).toBeUndefined();
    await expect(readFile(path.join(outDir, 'block.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accounts for object data and SVG href asset forms', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const design = path.join(directory, 'design.html');
    const source = path.join(directory, 'photo.png');
    await writeFile(design, '');
    await writeFile(source, 'photo');

    const report = await author(
      '<object data="photo.png"></object><svg><image href="photo.png" /><use xlink:href="photo.png#symbol" /></svg>',
      { sourcePath: design, outDir: path.join(directory, 'package'), author: { name: 'acme/assets' } },
    );

    expect(report.assets?.filter((asset) => asset.reference.startsWith('photo.png'))).toHaveLength(3);
    expect(report.ok).toBe(false);
    expect(report.package).toBeUndefined();
    expect(report.assets?.filter((asset) => asset.reference.startsWith('photo.png')).every((asset) => asset.outcome === 'prepared')).toBe(true);
  });

  it('accounts for SVG presentation URLs, SVG href variants, and link href asset forms', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const design = path.join(directory, 'design.html');
    await writeFile(design, '');
    await writeFile(path.join(directory, 'photo.png'), 'photo');

    const report = await author(
      '<link rel="icon" href="photo.png"><link rel="preload" as="image" href="photo.png"><link rel="manifest" href="photo.png"><link rel="stylesheet" href="photo.png"><svg><path fill="url(photo.png#paint)" filter="url(photo.png#filter)"/><mpath href="photo.png#motion"/><textPath href="photo.png#text">Text</textPath></svg>',
      {
        sourcePath: design,
        outDir: path.join(directory, 'package'),
        author: { name: 'acme/assets', styles: { mode: 'css', css: ' ' } },
      },
    );

    expect(report.ok).toBe(false);
    expect(report.package).toBeUndefined();
    const assetReferences = report.assets?.filter((asset) => asset.reference.startsWith('photo.png')) ?? [];
    expect(assetReferences).toHaveLength(8);
    expect(assetReferences.every((asset) => asset.outcome === 'prepared')).toBe(true);
    expect(assetReferences.map((asset) => asset.kind)).toEqual(expect.arrayContaining(['image', 'stylesheet', 'other']));
  });

  it('accounts for SVG gradient, pattern, and animation href references without treating SVG links as navigation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const design = path.join(directory, 'design.html');
    const outDir = path.join(directory, 'package');
    await writeFile(design, '');
    await writeFile(path.join(directory, 'gradients.svg'), '<svg/>');

    const report = await author(
      `<a href="guide.pdf">Guide</a><svg>
        <linearGradient href="gradients.svg#linear" />
        <radialGradient href="https://cdn.example/gradients.svg#radial" />
        <pattern xlink:href="#pattern" />
        <animate href="gradients.svg#animated" />
        <animateMotion xlink:href="gradients.svg#motion" />
        <animateTransform href="gradients.svg#transform" />
        <set xlink:href="gradients.svg#set" />
        <discard href="gradients.svg#discard" />
      </svg>`,
      { sourcePath: design, outDir, author: { name: 'acme/assets' } },
    );

    expect(report.ok).toBe(false);
    expect(report.package).toBeUndefined();
    const assets = report.assets ?? [];
    expect(assets).toHaveLength(8);
    expect(assets.filter((asset) => asset.reference.startsWith('gradients.svg')).every((asset) => asset.outcome === 'prepared')).toBe(true);
    expect(assets).toContainEqual(expect.objectContaining({
      reference: 'https://cdn.example/gradients.svg#radial',
      outcome: 'external',
    }));
    expect(assets).toContainEqual(expect.objectContaining({ reference: '#pattern', outcome: 'external' }));
    expect(assets.some((asset) => asset.reference === 'guide.pdf')).toBe(false);
  });

  it('blocks an unrecognized SVG href form instead of silently leaving it source-relative', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    scratch.push(directory);
    const design = path.join(directory, 'design.html');
    const outDir = path.join(directory, 'package');
    await writeFile(design, '');
    await writeFile(path.join(directory, 'unknown.svg'), '<svg/>');

    const report = await author(
      '<svg><foreignObject xlink:href="unknown.svg#content" /></svg>',
      { sourcePath: design, outDir, author: { name: 'acme/assets' } },
    );

    expect(report.ok).toBe(false);
    expect(report.assets).toContainEqual(expect.objectContaining({
      reference: 'unknown.svg#content',
      outcome: 'blocked',
      reason: expect.stringMatching(/foreignObject.*xlink:href.*recognized/i),
    }));
    await expect(readFile(path.join(outDir, 'block.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
