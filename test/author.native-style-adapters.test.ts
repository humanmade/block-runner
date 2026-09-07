import { describe, expect, it } from 'vitest';
import { author, collectSourceEvidence } from '../src/index.js';

function refs(html: string) {
  const entries = collectSourceEvidence(html).structure;
  return (tag: string, index = 0) => entries.filter((entry) => entry.tag === tag)[index]!.sourceRef!;
}

describe('native source-style adapters', () => {
  it('keeps button effects off the wrapper and maps direct image/caption and owned grids', async () => {
    const html = '<section class="grid"><div class="actions"><a class="move focus-visible:ring" href="/go">Go</a></div><img class="media-img" src="https://example.test/a.jpg" alt=""><figure class="figure"><img src="https://example.test/b.jpg" alt="Image"><figcaption class="caption">With <cite>source</cite></figcaption></figure></section>';
    const ref = refs(html);
    const report = await author(html, {
      author: { name: 'example/native-adapter', styles: { mode: 'css', css: [
        '.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; }',
        '.move:hover { margin-left: 1rem; transform: translateY(-2px); transition: transform 100ms; }',
        '.focus-visible\\:ring:focus-visible { outline: 2px solid red; }',
        '.caption { color: red; }',
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
});
