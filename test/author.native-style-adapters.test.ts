import { describe, expect, it } from 'vitest';
import { author, collectSourceEvidence } from '../src/index.js';
import { compileRegisteredBlock } from '../src/authoring/generate.js';
import { nativeSelectorSubjects } from '../src/author/styles.js';

function refs(html: string) {
  const entries = collectSourceEvidence(html).structure;
  return (tag: string, index = 0) => entries.filter((entry) => entry.tag === tag)[index]!.sourceRef!;
}

describe('native source-style adapters', () => {
  it('keeps button effects off the wrapper and maps direct image/caption and owned grids', async () => {
    const html = '<section class="grid"><div class="actions"><a class="move focus-visible:ring" href="/go">Go</a></div><img class="media-img" src="https://example.test/a.jpg" alt=""><figure class="figure"><img class="figure-img" src="https://example.test/b.jpg" alt="Image"><figcaption class="caption">With <cite>source</cite></figcaption></figure></section>';
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

  it('returns typed unresolved provenance when pinned core/image would override an authored sizing axis', async () => {
    const html = '<img class="media-img" src="https://example.test/a.jpg" alt="" width="1280" height="820">';
    const report = await author(html, {
      sourcePath: '/Users/example/a path with spaces/utility/hero intrinsic image source.html',
      author: { name: 'example/image-sizing', styles: { mode: 'css', css: '.media-img { width: 100%; }' } },
      proposal: { structure: [{ id: 'image', block: 'core/image', sourceRef: refs(html)('img') }] },
    });
    expect(report.package).toBeUndefined();
    expect(report.items).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'unresolved-native-style-mapping',
      details: expect.objectContaining({ cssSource: expect.any(Object), htmlSource: expect.objectContaining({ sourceRef: expect.any(String) }) }),
    })]));
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
