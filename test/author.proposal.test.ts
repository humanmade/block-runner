import { describe, expect, it } from 'vitest';
import { author, collectSourceEvidence } from '../src/index.js';

describe('author proposal boundary', () => {
  it('binds source content into a canonical plan without caller ledgers', async () => {
    const html = '<section><h2>Exact heading</h2><p>Keep <strong>rich text</strong>.</p><a href="/guide" target="_blank" rel="noopener">Read guide</a></section>';
    const evidence = collectSourceEvidence(html);
    const [section, heading, paragraph, link] = evidence.structure.filter((item) => ['section', 'h2', 'p', 'a'].includes(item.tag));
    const report = await author(html, { author: { name: 'example/proposal' }, proposal: { structure: [{ id: 'root', block: 'core/group', sourceRef: section!.sourceRef, children: [
      { id: 'heading', block: 'core/heading', sourceRef: heading!.sourceRef },
      { id: 'copy', block: 'core/paragraph', sourceRef: paragraph!.sourceRef },
      { id: 'buttons', block: 'core/buttons', children: [{ id: 'cta', block: 'core/button', sourceRef: link!.sourceRef }] },
    ] }], locking: { mode: 'contentOnly' } } });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    const nodes = report.package!.canonicalPlan!.structure[0]!.children!;
    expect(nodes[0]!.attributes).toMatchObject({ content: 'Exact heading', level: 2 });
    expect(nodes[1]!.attributes).toMatchObject({ content: 'Keep <strong>rich text</strong>.' });
    expect(nodes[2]!.children![0]!.attributes).toMatchObject({ text: 'Read guide', url: '/guide', linkTarget: '_blank', rel: 'noopener' });
    expect(report.package!.canonicalPlan!.coverage).toBeDefined();
  });

  it('rejects stale references and simultaneous canonical plans', async () => {
    const source = collectSourceEvidence('<p>Hello</p>');
    const proposal = { structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: source.structure.find((item) => item.tag === 'p')!.sourceRef! }] };
    const stale = await author('<p>Hello changed</p>', { author: { name: 'example/proposal' }, proposal });
    expect(stale.ok).toBe(false);
    expect(stale.items.map((item) => item.reason).join('\n')).toMatch(/stale|another source/i);
    const both = await author('<p>Hello</p>', { author: { name: 'example/proposal' }, proposal, plan: {} as never });
    expect(both.ok).toBe(false);
    expect(both.items.map((item) => item.reason).join('\n')).toMatch(/cannot be supplied together/i);
  });

  it('carries proposal-owned editing decisions and fails a silent omitted source element', async () => {
    const html = '<h2>Keep this heading</h2><p>Keep this paragraph</p>';
    const evidence = collectSourceEvidence(html);
    const paragraph = evidence.structure.find((item) => item.tag === 'p')!;
    const omitted = await author(html, { author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: paragraph.sourceRef }],
    } });
    expect(omitted.ok).toBe(false);
    expect(omitted.items.map((item) => item.reason).join('\n')).toMatch(/fulfillment failed/i);

    const heading = evidence.structure.find((item) => item.tag === 'h2')!;
    const reviewed = await author(html, { author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: paragraph.sourceRef }],
      fields: [], locking: { mode: 'contentOnly' }, allowedBlocks: ['core/paragraph'],
      pattern: { ready: true, overrides: [] },
      sourceDecisions: [{ action: 'omit', sourceRef: heading.sourceRef!, reason: 'Heading is represented by the page title.' }],
    } });
    expect(reviewed.ok, JSON.stringify(reviewed.items)).toBe(true);
    expect(reviewed.package!.canonicalPlan).toMatchObject({ fields: [], locking: { mode: 'contentOnly' }, allowedBlocks: ['core/paragraph'], pattern: { ready: true }, sourceDecisions: [{ action: 'omit', sourceRef: heading.sourceRef }] });
  });

  it('records reviewed replacements without treating source-decision action as executable data', async () => {
    const html = '<p>Original copy</p>';
    const reference = collectSourceEvidence(html).structure.find((item) => item.tag === 'p')!.sourceRef!;
    const report = await author(html, { author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: reference, attributes: { content: 'Revised copy' } }],
      sourceDecisions: [{ action: 'replace', sourceRef: reference, node: 'copy', attribute: 'content', value: 'Revised copy', reason: 'Approved editorial revision.' }],
    } });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect(report.package!.canonicalPlan!.sourceDecisions![0]).toMatchObject({ action: 'replace', original: 'Original copy', value: 'Revised copy' });
  });

  it('accounts for identical source units by reference and audits href aliases', async () => {
    const html = '<h2>Same</h2><h2>Same</h2><p>Discard</p><a href="/old">Read</a>';
    const evidence = collectSourceEvidence(html).structure;
    const [first, second] = evidence.filter((item) => item.tag === 'h2');
    const paragraph = evidence.find((item) => item.tag === 'p')!;
    const link = evidence.find((item) => item.tag === 'a')!;
    const failed = await author(html, { author: { name: 'example/proposal' }, proposal: { structure: [{ id: 'one', block: 'core/heading', sourceRef: first!.sourceRef }, { id: 'buttons', block: 'core/buttons', children: [{ id: 'cta', block: 'core/button', sourceRef: link.sourceRef }] }], sourceDecisions: [{ action: 'omit', sourceRef: paragraph.sourceRef!, reason: 'Unrelated review.' }] } });
    expect(failed.ok).toBe(false);
    const accepted = await author(html, { author: { name: 'example/proposal' }, proposal: { structure: [{ id: 'one', block: 'core/heading', sourceRef: first!.sourceRef }, { id: 'buttons', block: 'core/buttons', children: [{ id: 'cta', block: 'core/button', sourceRef: link.sourceRef }] }], sourceDecisions: [
      { action: 'omit', sourceRef: second!.sourceRef!, reason: 'Duplicate page title.' },
      { action: 'omit', sourceRef: paragraph.sourceRef!, reason: 'Unrelated review.' },
      { action: 'replace', sourceRef: link.sourceRef!, node: 'cta', attribute: 'url', value: '/new', reason: 'Approved URL.' },
    ] } });
    expect(accepted.ok, JSON.stringify(accepted.items)).toBe(true);
    expect(accepted.package!.canonicalPlan!.sourceDecisions).toEqual(expect.arrayContaining([expect.objectContaining({ attribute: 'url', original: '/old', value: '/new' })]));
  });

  it('retains residual selectors while promoting only exact native proposal styling and preserves HTTPS media', async () => {
    const html = '<p class="copy">Styled</p><figure><img src="https://cdn.example/hero.jpg" alt="Hero"><figcaption>Caption</figcaption></figure>';
    const evidence = collectSourceEvidence(html).structure;
    const copy = evidence.find((item) => item.tag === 'p')!;
    const figure = evidence.find((item) => item.tag === 'figure')!;
    const report = await author(html, { author: { name: 'example/proposal', styles: { mode: 'css', css: '.copy { color: red; margin-top: 1rem; }' } }, proposal: { structure: [
      { id: 'copy', block: 'core/paragraph', sourceRef: copy.sourceRef, attributes: { style: { color: { text: 'red' } } } },
      { id: 'image', block: 'core/image', sourceRef: figure.sourceRef },
    ] } });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    const plan = report.package!.canonicalPlan!;
    expect(plan.structure[0]!.attributes?.className).toContain('copy');
    expect(plan.coverage!.styles).toEqual(expect.arrayContaining([expect.objectContaining({ property: 'color', outcome: 'native', node: 'copy' }), expect.objectContaining({ property: 'margin-top', outcome: 'scoped-css' })]));
    expect(plan.styles.rules).toEqual(expect.arrayContaining([expect.objectContaining({ declarations: [expect.objectContaining({ property: 'margin-top' })] })]));
    expect(plan.structure[1]!.attributes).toMatchObject({ url: 'https://cdn.example/hero.jpg', alt: 'Hero', caption: 'Caption' });
    expect(plan.assets).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'https://cdn.example/hero.jpg', status: 'external' })]));
  });

  it('rejects incompatible or unused source decisions, while allowing a whole unbound figure omission', async () => {
    const html = '<h2>Keep me</h2><figure><img src="https://cdn.example/hero.jpg" alt="Hero"></figure>';
    const evidence = collectSourceEvidence(html).structure;
    const heading = evidence.find((item) => item.tag === 'h2')!;
    const figure = evidence.find((item) => item.tag === 'figure')!;
    const incompatible = await author(html, { author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'image', block: 'core/image', sourceRef: heading.sourceRef }],
      sourceDecisions: [{ action: 'omit', sourceRef: figure.sourceRef!, reason: 'Reviewed omission.' }],
    } });
    expect(incompatible.ok).toBe(false);
    expect(incompatible.items.map((item) => item.reason).join('\n')).toMatch(/cannot bind/i);
    const unused = await author('<p>Keep me</p>', { author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: collectSourceEvidence('<p>Keep me</p>').structure.find((item) => item.tag === 'p')!.sourceRef }],
      sourceDecisions: [{ action: 'add', sourceRef: collectSourceEvidence('<p>Keep me</p>').structure.find((item) => item.tag === 'p')!.sourceRef!, reason: 'No source disposition.' }],
    } });
    expect(unused.ok).toBe(false);
    expect(unused.items.map((item) => item.reason).join('\n')).toMatch(/does not consume/i);
    const omitted = await author(html, { author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'heading', block: 'core/heading', sourceRef: heading.sourceRef }],
      sourceDecisions: [{ action: 'omit', sourceRef: figure.sourceRef!, reason: 'Reviewed media omission.' }],
    } });
    expect(omitted.ok, JSON.stringify(omitted.items)).toBe(true);
  });

  it('keeps important declarations as scoped CSS rather than weakening them to native style', async () => {
    const html = '<p class="copy">Styled</p>';
    const reference = collectSourceEvidence(html).structure.find((item) => item.tag === 'p')!.sourceRef;
    const report = await author(html, { author: { name: 'example/proposal', styles: { mode: 'css', css: '.copy { color: red !important; }' } }, proposal: {
      structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: reference }],
    } });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect(report.package!.canonicalPlan!.coverage!.styles).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'color', outcome: 'scoped-css' }),
    ]));
  });

});
