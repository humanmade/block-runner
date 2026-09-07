import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  author,
  collectSourceEvidence,
  compileRegisteredBlock,
  hashAuthoringConfirmation,
  hashAuthoringPlan,
  inspectAuthoringDestination,
  planRegisteredBlockOutput,
  renderAuthoringPreview,
  writeGeneratedRegisteredBlock,
} from '../src/index.js';

const benchmarkRoot = path.resolve('benchmarks/authoring/sources');
async function source(relative: string): Promise<{ html: string; sourcePath: string }> {
  const sourcePath = path.join(benchmarkRoot, relative);
  return { html: await readFile(sourcePath, 'utf8'), sourcePath };
}
function refs(html: string) {
  const evidence = collectSourceEvidence(html).structure;
  return (tag: string, occurrence = 0) => evidence.filter((item) => item.tag === tag)[occurrence]!.sourceRef!;
}

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

  it('locates structurally valid stale references from a foreign source hash', async () => {
    const html = '<section>\n  <p>Hello</p>\n</section>';
    const evidence = collectSourceEvidence(html);
    const paragraph = evidence.structure.find((item) => item.tag === 'p')!;
    const foreignRef = `${'f'.repeat(64)}:${paragraph.sourceRef!.split(':')[1]}`;
    const report = await author(html, { sourcePath: '/design/multiline.html', author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: foreignRef }],
      sourceDecisions: [{ action: 'omit', sourceRef: foreignRef, reason: 'Must remain stale.' }],
    } });
    expect(report.ok).toBe(false);
    expect(report.package).toBeUndefined();
    const reason = report.items.map((item) => item.reason).join('\n');
    expect(reason).toMatch(/stale|another source/i);
    expect(reason).toContain('/design/multiline.html:2:3 (offset 12)');
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

  it.each([
    ['semantic/hero.html', 'semantic hero'],
    ['utility/hero.html', 'utility hero'],
  ])('binds every editable hero unit from %s', async (relative) => {
    const { html, sourcePath } = await source(relative);
    const ref = refs(html);
    const report = await author(html, { sourcePath, author: { name: 'example/hero' }, proposal: { structure: [{ id: 'hero', block: 'core/group', sourceRef: ref('section'), children: [
      { id: 'content', block: 'core/group', sourceRef: ref('div', 1), children: [
        { id: 'eyebrow', block: 'core/paragraph', sourceRef: ref('p', 0) },
        { id: 'title', block: 'core/heading', sourceRef: ref('h1') },
        { id: 'lede', block: 'core/paragraph', sourceRef: ref('p', 1) },
        { id: 'buttons', block: 'core/buttons', sourceRef: ref('div', 2), children: [
          { id: 'download', block: 'core/button', sourceRef: ref('a', 0) },
          { id: 'guide', block: 'core/button', sourceRef: ref('a', 1) },
        ] },
      ] },
      { id: 'image', block: 'core/image', sourceRef: ref('figure') },
    ] }], fields: [{ id: 'title-content', label: 'Title', mode: 'editable', node: 'title', attribute: 'content' }], locking: { mode: 'contentOnly' } } });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    const plan = report.package!.canonicalPlan!;
    expect(plan.structure[0]!.children![0]!.children![1]!.attributes).toMatchObject({ content: 'Build a WordPress block your team can keep editing.', level: 1 });
    expect(plan.structure[0]!.children![0]!.children![3]!.children![0]!.attributes).toMatchObject({ text: 'Download the testing release', url: '/download' });
    expect(plan.structure[0]!.children![1]!.attributes).toMatchObject({ url: '/wp-content/uploads/block-runner-editor.png', alt: 'A WordPress editor sidebar with editable block controls', caption: 'Native controls stay with the block, not in a screenshot.' });
    expect(plan.fields).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'title-content', mode: 'editable' })]));
    expect(plan.locking).toEqual({ mode: 'contentOnly' });
  });

  it('binds the semantic cards hierarchy without dropping content', async () => {
    const { html, sourcePath } = await source('semantic/cards.html');
    const ref = refs(html);
    const card = (index: number, ids: [string, string, string, string]) => ({ id: `card-${index}`, block: 'core/group', sourceRef: ref('article', index), children: [
      ...(index === 1 ? [{ id: ids[0], block: 'core/paragraph', sourceRef: ref('p', 4) }] : []),
      { id: ids[1], block: 'core/heading', sourceRef: ref('h3', index) },
      { id: ids[2], block: 'core/paragraph', sourceRef: ref('p', index === 0 ? 2 : index === 1 ? 5 : 7) },
      { id: `${ids[2]}-copy`, block: 'core/paragraph', sourceRef: ref('p', index === 0 ? 3 : index === 1 ? 6 : 8) },
      { id: `${ids[3]}-buttons`, block: 'core/buttons', children: [{ id: ids[3], block: 'core/button', sourceRef: ref('a', index) }] },
    ] });
    const report = await author(html, { sourcePath, author: { name: 'example/cards' }, proposal: { structure: [{ id: 'cards', block: 'core/group', sourceRef: ref('section'), children: [
      { id: 'heading', block: 'core/group', sourceRef: ref('header'), children: [
        { id: 'eyebrow', block: 'core/paragraph', sourceRef: ref('p', 0) }, { id: 'title', block: 'core/heading', sourceRef: ref('h2') }, { id: 'intro', block: 'core/paragraph', sourceRef: ref('p', 1) },
      ] },
      { id: 'grid', block: 'core/group', sourceRef: ref('div'), children: [card(0, ['unused', 'starter', 'starter-price', 'starter-link']), card(1, ['badge', 'team', 'team-price', 'team-link']), card(2, ['unused', 'studio', 'studio-price', 'studio-link'])] },
    ] }] } });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    const plan = report.package!.canonicalPlan!;
    expect(plan.structure[0]!.children![1]!.children).toHaveLength(3);
    expect(plan.structure[0]!.children![1]!.children![1]!.children![1]!.attributes).toMatchObject({ content: 'Team', level: 3 });
    expect(plan.structure[0]!.children![1]!.children![2]!.children![3]!.children![0]!.attributes).toMatchObject({ text: 'Contact us', url: '/studio' });
  });

  it('keeps local assets, deterministic hashes, and the reviewed output path intact', async () => {
    const { html } = await source('semantic/local-assets.html');
    const ref = refs(html);
    const proposal = { structure: [{ id: 'root', block: 'core/group', sourceRef: ref('section'), children: [
      { id: 'copy', block: 'core/group', sourceRef: ref('div'), children: [
        { id: 'eyebrow', block: 'core/paragraph', sourceRef: ref('p', 0) }, { id: 'title', block: 'core/heading', sourceRef: ref('h2') }, { id: 'body', block: 'core/paragraph', sourceRef: ref('p', 1) }, { id: 'buttons', block: 'core/buttons', children: [{ id: 'cta', block: 'core/button', sourceRef: ref('a') }] },
      ] }, { id: 'image', block: 'core/image', sourceRef: ref('figure') },
    ] }] };
    // The fixture's URL is deliberately relative to the shared sources directory; retain that
    // real fixture asset while presenting the source under its owning asset root.
    const options = { sourcePath: path.join(benchmarkRoot, 'assets', 'local-assets.html'), author: { name: 'example/local-assets' }, proposal };
    const [first, second] = await Promise.all([author(html, options), author(html, options)]);
    expect(first.ok, JSON.stringify(first.items)).toBe(true);
    expect(second.ok).toBe(true);
    const plan = first.package!.canonicalPlan!;
    expect(plan).toEqual(second.package!.canonicalPlan);
    expect(hashAuthoringPlan(plan)).toBe(hashAuthoringPlan(second.package!.canonicalPlan!));
    expect(plan.structure[0]!.children![1]!.attributes).toMatchObject({ alt: 'Aurora dashboard with color tokens, release receipts, and a completed activation check', caption: 'Local SVG fixture: no network asset may substitute for this file.' });
    expect(first.package!.assets).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringMatching(/^assets\/aurora-dashboard-/) })]));
    const output = planRegisteredBlockOutput(plan);
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-proposal-'));
    try {
      const inspection = await inspectAuthoringDestination(destination, output);
      const confirmation = hashAuthoringConfirmation(plan, inspection);
      expect(renderAuthoringPreview(plan, { confirmationHash: confirmation })).toContain(confirmation);
      const generated = compileRegisteredBlock(plan);
      const written = await writeGeneratedRegisteredBlock(destination, generated, inspection);
      expect(written.written).toEqual(expect.arrayContaining(['block.json']));
      await expect(readFile(path.join(destination, plan.assets[0]!.destination!))).resolves.toBeInstanceOf(Buffer);
    } finally { await rm(destination, { recursive: true, force: true }); }
    const changed = await author(`${html}\n`, options);
    expect(changed.ok).toBe(false);
    expect(changed.items.map((item) => item.reason).join('\n')).toMatch(/stale|another source/i);
    const oldHash = ref('section').split(':')[0]!;
    const rebuiltHash = refs(`${html}\n`)('section').split(':')[0]!;
    const rebuiltProposal = JSON.parse(JSON.stringify(proposal).replaceAll(oldHash, rebuiltHash));
    const rebuilt = await author(`${html}\n`, { ...options, proposal: rebuiltProposal });
    expect(rebuilt.ok, JSON.stringify(rebuilt.items)).toBe(true);
    expect(hashAuthoringPlan(rebuilt.package!.canonicalPlan!)).not.toBe(hashAuthoringPlan(plan));
    const changedDestination = await mkdtemp(path.join(tmpdir(), 'block-runner-proposal-changed-'));
    try {
      expect(hashAuthoringConfirmation(rebuilt.package!.canonicalPlan!, await inspectAuthoringDestination(changedDestination, planRegisteredBlockOutput(rebuilt.package!.canonicalPlan!))))
        .not.toBe(hashAuthoringConfirmation(plan, await inspectAuthoringDestination(changedDestination, output)));
    } finally { await rm(changedDestination, { recursive: true, force: true }); }
  });

  it('fails closed for executable markup and unsafe source-owned replacements', async () => {
    const executable = await author('<script>alert(1)</script><p>Safe</p>', { author: { name: 'example/unsafe' }, proposal: { structure: [] } });
    expect(executable.ok).toBe(false);
    expect(executable.package).toBeUndefined();
    const html = '<p>Safe</p>';
    const sourceRef = refs(html)('p');
    const unsafe = await author(html, { author: { name: 'example/unsafe' }, proposal: { structure: [{ id: 'copy', block: 'core/paragraph', sourceRef, attributes: { content: '<script>alert(1)</script>' } }], sourceDecisions: [{ action: 'replace', sourceRef, node: 'copy', attribute: 'content', value: '<script>alert(1)</script>', reason: 'Unsafe regression.' }] } });
    expect(unsafe.ok).toBe(false);
    expect(unsafe.package).toBeUndefined();
  });

});
