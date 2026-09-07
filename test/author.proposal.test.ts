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
});
