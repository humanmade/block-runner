import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { author, collectSourceEvidence } from '../src/index.js';
import { compileRegisteredBlock } from '../src/authoring/generate.js';
import { nativeSelectorSubjects } from '../src/author/styles.js';

function refs(html: string) {
  const entries = collectSourceEvidence(html).structure;
  return (tag: string, index = 0) => entries.filter((entry) => entry.tag === tag)[index]!.sourceRef!;
}

const utilitySourceRoot = path.resolve('benchmarks/authoring/sources/utility');
const omissions = (html: string, used: ReadonlySet<string>) => collectSourceEvidence(html).structure
  .filter((entry) => /^(h[1-6]|p|li|figure|a)$/.test(entry.tag) && entry.sourceRef && !used.has(entry.sourceRef))
  .map((entry) => ({ action: 'omit' as const, sourceRef: entry.sourceRef!, reason: 'This focused adapter case intentionally covers only the native style subjects.' }));

describe('native source-style adapters', () => {
  it('applies shared adapters to the checked-in utility hero, split-feature, and cards sources', async () => {
    const hero = await readFile(path.join(utilitySourceRoot, 'hero.html'), 'utf8');
    const heroRef = refs(hero);
    const heroUsed = new Set([heroRef('a'), heroRef('a', 1), heroRef('figure')]);
    const heroReport = await author(hero, { sourcePath: path.join(utilitySourceRoot, 'hero.html'), author: { name: 'example/utility-hero', styles: { mode: 'css', css: '.grid { display:grid; grid-template-columns:repeat(2,1fr); gap:3rem; } .px-5:hover { transform:translateY(-2px); padding:1.25rem; transition:transform 150ms; } .focus-visible\\:outline:focus-visible { outline:2px solid currentColor; } .w-full { width:100%; } .mt-3 { color:#94a3b8; }' } }, proposal: { structure: [{ id: 'hero', block: 'core/group', sourceRef: heroRef('section'), children: [{ id: 'grid', block: 'core/group', sourceRef: heroRef('div'), children: [{ id: 'buttons', block: 'core/buttons', sourceRef: heroRef('div', 2), children: [{ id: 'download', block: 'core/button', sourceRef: heroRef('a') }, { id: 'guide', block: 'core/button', sourceRef: heroRef('a', 1) }] }, { id: 'image', block: 'core/image', sourceRef: heroRef('figure') }] }] }], sourceDecisions: omissions(hero, heroUsed) } });
    expect(heroReport.ok, JSON.stringify(heroReport.items)).toBe(true);
    const heroPlan = heroReport.package!.canonicalPlan!;
    expect(heroPlan.coverage!.styles.some((entry) => entry.nativeTargets?.some((target) => target.role === 'button-link'))).toBe(true);
    expect(heroPlan.coverage!.styles.some((entry) => entry.nativeTargets?.some((target) => target.role === 'caption'))).toBe(true);
    expect(heroPlan.coverage!.styles.some((entry) => entry.nativeTargets?.some((target) => target.intrinsic?.aspectRatio === '1280 / 820'))).toBe(true);

    const split = await readFile(path.join(utilitySourceRoot, 'split-feature.html'), 'utf8');
    const splitRef = refs(split);
    const splitUsed = new Set([splitRef('img'), splitRef('a')]);
    const splitReport = await author(split, { sourcePath: path.join(utilitySourceRoot, 'split-feature.html'), author: { name: 'example/utility-split', styles: { mode: 'css', css: '.grid { display:grid; grid-template-columns:repeat(2,1fr); gap:2.5rem; } .w-full { width:100%; } .hover\\:text-indigo-900:hover { color:#312e81; }' } }, proposal: { structure: [{ id: 'feature', block: 'core/group', sourceRef: splitRef('section'), children: [{ id: 'image', block: 'core/image', sourceRef: splitRef('img') }, { id: 'buttons', block: 'core/buttons', children: [{ id: 'link', block: 'core/button', sourceRef: splitRef('a') }] }] }], sourceDecisions: omissions(split, splitUsed) } });
    expect(splitReport.ok, JSON.stringify(splitReport.items)).toBe(true);
    expect(splitReport.package!.canonicalPlan!.structure[0]!.attributes?.layout).toMatchObject({ type: 'grid' });
    expect(splitReport.package!.canonicalPlan!.coverage!.styles.some((entry) => entry.nativeTargets?.some((target) => target.role === 'image'))).toBe(true);

    const cards = await readFile(path.join(utilitySourceRoot, 'cards.html'), 'utf8');
    const cardsRef = refs(cards);
    const cardsUsed = new Set([cardsRef('a'), cardsRef('a', 1), cardsRef('a', 2)]);
    const cardsReport = await author(cards, { sourcePath: path.join(utilitySourceRoot, 'cards.html'), author: { name: 'example/utility-cards', styles: { mode: 'css', css: '.grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1.5rem; } .inline-flex:hover { transform:translateY(-2px); }' } }, proposal: { structure: [{ id: 'cards', block: 'core/group', sourceRef: cardsRef('section'), children: [{ id: 'grid', block: 'core/group', sourceRef: cardsRef('div', 1), children: [{ id: 'buttons-1', block: 'core/buttons', children: [{ id: 'card-1', block: 'core/button', sourceRef: cardsRef('a') }] }, { id: 'buttons-2', block: 'core/buttons', children: [{ id: 'card-2', block: 'core/button', sourceRef: cardsRef('a', 1) }] }, { id: 'buttons-3', block: 'core/buttons', children: [{ id: 'card-3', block: 'core/button', sourceRef: cardsRef('a', 2) }] }] }] }], sourceDecisions: omissions(cards, cardsUsed) } });
    expect(cardsReport.ok, JSON.stringify(cardsReport.items)).toBe(true);
    expect(cardsReport.package!.canonicalPlan!.structure[0]!.children![0]!.attributes?.layout).toMatchObject({ type: 'grid' });
    expect(cardsReport.package!.canonicalPlan!.coverage!.styles.some((entry) => entry.nativeTargets?.some((target) => target.role === 'button-link'))).toBe(true);
  }, 30_000);

  it('keeps button effects off the wrapper and maps direct image/caption and owned grids', async () => {
    const html = '<section class="grid"><div class="actions"><a class="move focus-visible:ring" href="/go">Go</a></div><img class="media-img" src="https://example.test/a.jpg" alt="" width="320" height="180"><figure class="figure"><img class="figure-img" src="https://example.test/b.jpg" alt="Image" width="200" height="125"><figcaption class="caption">With <cite>source</cite></figcaption></figure></section>';
    const ref = refs(html);
    const report = await author(html, {
      author: { name: 'example/native-adapter', styles: { mode: 'css', css: [
        '.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; }',
        '.move:hover { margin-left: 1rem; transform: translateY(-2px); transition: transform 100ms; }',
        '.focus-visible\\:ring:focus-visible { outline: 2px solid red; }',
        '.media-img { width: 320px; height: 180px; }',
        'figure.figure > img.figure-img { width: 200px; }',
        'figure.figure > figcaption.caption { color: red; }',
      ].join('\n') } },
      proposal: { structure: [{ id: 'grid', block: 'core/group', sourceRef: ref('section'), children: [
        { id: 'buttons', block: 'core/buttons', sourceRef: ref('div'), children: [{ id: 'button', block: 'core/button', sourceRef: ref('a') }] },
        { id: 'direct', block: 'core/image', sourceRef: ref('img') },
        { id: 'figure', block: 'core/image', sourceRef: ref('figure') },
      ] }] },
    });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    const plan = report.package!.canonicalPlan!;
    const generated = plan.styles.rules!.filter((rule): rule is Extract<typeof rule, { kind: 'style' }> => rule.kind === 'style' && Boolean(rule.generated));
    expect(generated.some((rule) => rule.selector.includes('.wp-block-button__link:hover'))).toBe(true);
    expect(generated.some((rule) => rule.generated === 'native-adapter-wrapper-reset' && rule.declarations.some((declaration) => declaration.property === 'margin-left' && declaration.value === '0'))).toBe(true);
    expect(generated.some((rule) => rule.selector.includes('> figcaption.wp-element-caption'))).toBe(true);
    expect(plan.coverage!.styles.some((entry) => entry.nativeTargets?.some((target) => target.role === 'caption'))).toBe(true);
    expect(plan.structure[0]!.attributes?.layout).toMatchObject({ type: 'grid' });
  });

  it('rejects grid declarations without unconditional source display:grid', async () => {
    const html = '<section class="grid"><p>Grid</p></section>';
    const report = await author(html, {
      author: { name: 'example/no-grid-owner', styles: { mode: 'css', css: '@media (max-width: 600px) { .grid { gap: 1rem; } }' } },
      proposal: { structure: [{ id: 'grid', block: 'core/group', sourceRef: refs(html)('section'), attributes: { layout: { type: 'grid' } }, children: [{ id: 'copy', block: 'core/paragraph', sourceRef: refs(html)('p') }] }] },
    });
    expect(report.package).toBeUndefined();
    expect(report.items).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unresolved-native-style-mapping' })]));
  });

  it('reads complete image class atoms and bounded figure child compounds', () => {
    expect(nativeSelectorSubjects('.media-img')).toMatchObject([{ staticSelector: '.media-img', classes: [{ decoded: 'media-img' }] }]);
    expect(nativeSelectorSubjects('figure.frame > img.media-img:hover')).toMatchObject([{
      staticSelector: 'figure.frame', relation: 'image', terminalSelector: 'img.media-img', state: 'hover',
    }]);
    expect(nativeSelectorSubjects('figure.frame > figcaption.caption:focus-visible')).toMatchObject([{
      staticSelector: 'figure.frame', relation: 'caption', terminalSelector: 'figcaption.caption', state: 'focus-visible',
    }]);
    expect(nativeSelectorSubjects('.focus-visible\\:outline')).toMatchObject([{ classes: [{ decoded: 'focus-visible:outline' }] }]);
  });

  it('rejects unsupported authored grid properties with separate CSS and HTML provenance', async () => {
    const html = '<section class="grid"><p>Grid</p></section>';
    const report = await author(html, {
      sourcePath: '/a deliberately long source path/with spaces/utility grid.html',
      author: { name: 'example/unsupported-grid', styles: { mode: 'css', css: '.grid { display: grid; grid-auto-flow: dense; }' } },
      proposal: { structure: [{ id: 'grid', block: 'core/group', sourceRef: refs(html)('section'), children: [{ id: 'copy', block: 'core/paragraph', sourceRef: refs(html)('p') }] }] },
    });
    const item = report.items.find((candidate) => candidate.code === 'unresolved-native-style-mapping')!;
    expect(report.package).toBeUndefined();
    expect(item.source).toMatchObject({ path: '/a deliberately long source path/with spaces/utility grid.html' });
    expect(item.details).toMatchObject({ cssSource: { selector: '.grid' }, htmlSource: { path: '/a deliberately long source path/with spaces/utility grid.html' } });
  });

  it('preserves intrinsic image dimensions as ratio provenance when authored CSS owns sizing', async () => {
    const html = '<img class="media-img" src="https://example.test/a.jpg" alt="" width="1280" height="820">';
    const report = await author(html, {
      sourcePath: '/Users/example/a path with spaces/utility/hero intrinsic image source.html',
      author: { name: 'example/image-sizing', styles: { mode: 'css', css: '.media-img { width: 100%; }' } },
      proposal: { structure: [{ id: 'image', block: 'core/image', sourceRef: refs(html)('img') }] },
    });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    const plan = report.package!.canonicalPlan!;
    expect(plan.structure[0]!.attributes).toMatchObject({ aspectRatio: '1280 / 820' });
    expect(plan.structure[0]!.attributes).not.toHaveProperty('width');
    expect(plan.structure[0]!.attributes).not.toHaveProperty('height');
    expect(plan.coverage!.styles[0]!.nativeTargets![0]!.intrinsic).toEqual({ width: '1280', height: '820', aspectRatio: '1280 / 820' });
    expect(compileRegisteredBlock(plan).template[0]![1]).toMatchObject({ aspectRatio: '1280 / 820' });
    const forged = structuredClone(plan);
    for (const entry of forged.coverage!.styles) for (const target of entry.nativeTargets ?? []) delete target.intrinsic;
    forged.structure[0]!.attributes!.width = '1280';
    forged.structure[0]!.attributes!.height = '820';
    expect(() => compileRegisteredBlock(forged)).toThrow(/without overriding generated image CSS/);
  });

  it('locates an unsupported relationship on its matched unwrapped anchor, not the first binding', async () => {
    const html = '<div>                <a class="move" href="/go">Go</a></div>';
    const report = await author(html, {
      sourcePath: '/Users/warden/Library/Application Support/Block Runner/previews/2026-09-05/export/long-project/preview.html',
      author: { name: 'example/unwrapped-button', styles: { mode: 'css', css: 'div .move:hover { color: red; }' } },
      proposal: { structure: [{ id: 'section', block: 'core/group', sourceRef: refs(html)('div') }, { id: 'button', block: 'core/button', sourceRef: refs(html)('a') }] },
    });
    const item = report.items.find((candidate) => candidate.code === 'unresolved-native-style-mapping')!;
    expect(report.package).toBeUndefined();
    expect(item.source).toMatchObject({ path: '/Users/warden/Library/Application Support/Block Runner/previews/2026-09-05/export/long-project/preview.html', offset: 21, htmlLine: 1, htmlColumn: 22 });
    expect(item.details).toMatchObject({ htmlSource: { path: '/Users/warden/Library/Application Support/Block Runner/previews/2026-09-05/export/long-project/preview.html', offset: 21 }, cssSource: { selector: 'div .move:hover' } });
  });

  it('rejects adapter targets whose marker is absent from serialized native markup', async () => {
    const html = '<div><a class="move" href="/go">Go</a></div>';
    const report = await author(html, {
      author: { name: 'example/marker-proof', styles: { mode: 'css', css: '.move:hover { color: red; }' } },
      proposal: { structure: [{ id: 'buttons', block: 'core/buttons', sourceRef: refs(html)('div'), children: [{ id: 'button', block: 'core/button', sourceRef: refs(html)('a') }] }] },
    });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    const plan = structuredClone(report.package!.canonicalPlan!);
    plan.structure[0]!.children![0]!.attributes!.className = '';
    expect(() => compileRegisteredBlock(plan)).toThrow(/serialized markup/);
  });

  it('rejects submitted native-target provenance with altered declaration importance', async () => {
    const html = '<div><a class="move" href="/go">Go</a></div>';
    const report = await author(html, {
      author: { name: 'example/importance-proof', styles: { mode: 'css', css: '.move:hover { color: red; }' } },
      proposal: { structure: [{ id: 'buttons', block: 'core/buttons', sourceRef: refs(html)('div'), children: [{ id: 'button', block: 'core/button', sourceRef: refs(html)('a') }] }] },
    });
    const plan = structuredClone(report.package!.canonicalPlan!);
    plan.coverage!.styles.find((entry) => entry.nativeTargets?.length)!.nativeTargets![0]!.important = true;
    expect(() => compileRegisteredBlock(plan)).toThrow(/selector\/provenance/);
  });
});
