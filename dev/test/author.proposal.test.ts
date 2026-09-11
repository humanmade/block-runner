import { describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
} from '../../src/index.js';
import { validateSourceContent } from '../../src/author/content.js';
import type { AuthoringStructureNode, JsonValue } from '../../src/authoring/schema.js';

const benchmarkRoot = path.resolve('dev/benchmarks/authoring/sources');
async function source(relative: string): Promise<{ html: string; sourcePath: string }> {
  const sourcePath = path.join(benchmarkRoot, relative);
  return { html: await readFile(sourcePath, 'utf8'), sourcePath };
}
function refs(html: string) {
  const evidence = collectSourceEvidence(html).structure;
  return (tag: string, occurrence = 0) => evidence.filter((item) => item.tag === tag)[occurrence]!.sourceRef!;
}
function nodesById(nodes: readonly AuthoringStructureNode[]) {
  const result = new Map<string, AuthoringStructureNode>();
  const visit = (items: readonly AuthoringStructureNode[]) => items.forEach((node) => {
    if (node.id === undefined) throw new Error('Author proposal fixture node must have an id');
    result.set(node.id, node);
    if (node.children) visit(node.children);
  });
  visit(nodes);
  return result;
}

describe('author proposal boundary', () => {
  it('binds an authored heading ID to its native anchor while retaining an internal link', async () => {
    const html = '<h2 id="details">Details</h2><a href="#details">Read details</a>';
    const ref = refs(html);
    const report = await author(html, { author: { name: 'example/anchors' }, proposal: { structure: [
      { id: 'heading', block: 'core/heading', sourceRef: ref('h2') },
      { id: 'buttons', block: 'core/buttons', children: [{ id: 'link', block: 'core/button', sourceRef: ref('a') }] },
    ] } });

    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    const structure = report.package!.canonicalPlan!.structure;
    expect(structure[0]!.attributes).toMatchObject({ content: 'Details', level: 2, anchor: 'details' });
    expect(structure[1]!.children![0]!.attributes).toMatchObject({ text: 'Read details', url: '#details' });
    validateSourceContent(html, compileRegisteredBlock(report.package!.canonicalPlan!).template);
  });

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

  it('locates a proposal-node stale reference from a foreign source hash', async () => {
    const html = '<section>\n  <p>Hello</p>\n</section>';
    const evidence = collectSourceEvidence(html);
    const paragraph = evidence.structure.find((item) => item.tag === 'p')!;
    const foreignRef = `${'f'.repeat(64)}:${paragraph.sourceRef!.split(':')[1]}`;
    const report = await author(html, { sourcePath: '/design/multiline.html', author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: foreignRef }],
    } });
    expect(report.ok).toBe(false);
    expect(report.package).toBeUndefined();
    const reason = report.items.map((item) => item.reason).join('\n');
    expect(reason).toContain('proposal sourceRef');
    expect(reason).toMatch(/stale|another source/i);
    expect(reason).not.toContain('(offset 12)');
    expect(report.items[0]).toMatchObject({ code: 'stale-proposal-source-ref', source: { path: '/design/multiline.html' }, details: { sourceRef: foreignRef, referenceVerified: false } });
    expect(report.items[0]!.source).not.toHaveProperty('offset');
    expect(report.items[0]!.source).not.toHaveProperty('htmlLine');
  });

  it('locates a source-decision stale reference from a foreign source hash', async () => {
    const html = '<section>\n  <p>Hello</p>\n</section>';
    const paragraph = collectSourceEvidence(html).structure.find((item) => item.tag === 'p')!;
    const foreignRef = `${'f'.repeat(64)}:${paragraph.sourceRef!.split(':')[1]}`;
    const report = await author(html, { sourcePath: '/design/multiline.html', author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: paragraph.sourceRef }],
      sourceDecisions: [{ action: 'omit', sourceRef: foreignRef, reason: 'Must remain stale.' }],
    } });
    expect(report.ok).toBe(false);
    expect(report.package).toBeUndefined();
    const reason = report.items.map((item) => item.reason).join('\n');
    expect(reason).toContain('proposal decision sourceRef');
    expect(reason).toMatch(/stale|another source/i);
    expect(reason).not.toContain('(offset 12)');
    expect(report.items[0]).toMatchObject({ code: 'stale-proposal-source-ref', source: { path: '/design/multiline.html' }, details: { sourceRef: foreignRef, referenceVerified: false } });
    expect(report.items[0]!.source).not.toHaveProperty('offset');
    expect(report.items[0]!.source).not.toHaveProperty('htmlLine');
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

  it.each([
    ['direct image', '<img src="/hero.jpg" alt="Hero" width="640" height="480">', 'img'],
    ['figure image', '<figure><img src="/hero.jpg" alt="Hero" width="640" height="480"></figure>', 'figure'],
  ])('binds %s dimensions from equivalent numeric proposal values as source strings', async (_name, html, tag) => {
    const reference = refs(html)(tag);
    const report = await author(html, { author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'image', block: 'core/image', sourceRef: reference, attributes: { width: 640, height: 480 } }],
    } });
    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect(report.package!.canonicalPlan!.structure[0]!.attributes).toMatchObject({ width: '640', height: '480' });
    expect(report.package!.canonicalPlan!.sourceDecisions).toBeUndefined();
    const omitted = await author(html, { author: { name: 'example/proposal' }, proposal: {
      structure: [{ id: 'image', block: 'core/image', sourceRef: reference, attributes: { width: 640 } }],
      sourceDecisions: [{ action: 'omit', sourceRef: reference, node: 'image', attribute: 'height', reason: 'Height is intentionally omitted.' }],
    } });
    expect(omitted.ok, JSON.stringify(omitted.items)).toBe(true);
    expect(omitted.package!.canonicalPlan!.structure[0]!.attributes).toMatchObject({ width: '640' });
    expect(omitted.package!.canonicalPlan!.structure[0]!.attributes).not.toHaveProperty('height');
    expect(omitted.package!.canonicalPlan!.sourceDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'omit', attribute: 'height', original: '480' }),
    ]));
  });

  it('requires decisions for changed or invalid image dimension proposal values', async () => {
    const html = '<img src="/hero.jpg" alt="Hero" width="640" height="480">';
    const reference = refs(html)('img');
    const proposal = (width: JsonValue, height: JsonValue) => ({ structure: [{ id: 'image', block: 'core/image', sourceRef: reference, attributes: { width, height } }] });
    const changed = await author(html, { author: { name: 'example/proposal' }, proposal: proposal(641, 480) });
    expect(changed.ok).toBe(false);
    expect(changed.items.map((item) => item.reason).join('\n')).toMatch(/changes source content without an explicit source decision/i);
    for (const value of [640.5, 0, -640, Infinity, true, {}, Number.MAX_SAFE_INTEGER + 1, '640px']) {
      const rejected = await author(html, { author: { name: 'example/proposal' }, proposal: proposal(value, 480) });
      expect(rejected.ok, `${String(value)}: ${JSON.stringify(rejected.items)}`).toBe(false);
    }
    const reviewed = await author(html, { author: { name: 'example/proposal' }, proposal: {
      ...proposal('641', 480),
      sourceDecisions: [{ action: 'replace', sourceRef: reference, node: 'image', attribute: 'width', value: '641', reason: 'Approved image crop.' }],
    } });
    expect(reviewed.ok, JSON.stringify(reviewed.items)).toBe(true);
    expect(reviewed.package!.canonicalPlan!.structure[0]!.attributes).toMatchObject({ width: '641', height: '480' });
    expect(reviewed.package!.canonicalPlan!.sourceDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'replace', attribute: 'width', original: '640', value: '641' }),
    ]));
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
    const report = await author(html, { sourcePath, author: { name: 'example/hero', ...(relative === 'utility/hero.html' ? { styles: { mode: 'css' as const, css: '.px-5 { padding: 1.25rem; transition: transform 150ms; } .hover\\:bg-cyan-200:hover { transform: translateY(-2px); } .focus-visible\\:outline:focus-visible { outline: 2px solid currentColor; }' } } : {}) }, proposal: { structure: [{ id: 'hero', block: 'core/group', sourceRef: ref('section'), children: [
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
    const nodes = nodesById(plan.structure);
    expect(nodes.get('eyebrow')!.attributes).toMatchObject({ content: 'Block Runner 0.9' });
    expect(nodes.get('title')!.attributes).toMatchObject({ content: 'Build a WordPress block your team can keep editing.', level: 1 });
    expect(nodes.get('lede')!.attributes).toMatchObject({ content: 'Turn a finished interface into a registered block with clear controls, native markup, and a source trail reviewers can inspect.' });
    expect(nodes.get('download')!.attributes).toMatchObject({ text: 'Download the testing release', url: '/download' });
    expect(nodes.get('guide')!.attributes).toMatchObject({ text: 'Read the authoring guide', url: '/docs/authoring' });
    expect(nodes.get('image')!.attributes).toMatchObject({ url: '/wp-content/uploads/block-runner-editor.png', alt: 'A WordPress editor sidebar with editable block controls', caption: 'Native controls stay with the block, not in a screenshot.' });
    expect(plan.fields).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'title-content', mode: 'editable' })]));
    expect(plan.locking).toEqual({ mode: 'contentOnly' });
    if (relative === 'utility/hero.html') {
      const generated = plan.styles.rules?.filter((rule): rule is Extract<typeof rule, { kind: 'style' }> => rule.kind === 'style' && Boolean(rule.generated)) ?? [];
      expect(generated.some((rule) => rule.generated === 'native-adapter-target' && rule.selector.includes('.wp-block-button__link'))).toBe(true);
      expect(generated.some((rule) => rule.generated === 'native-adapter-wrapper-reset')).toBe(true);
      expect(plan.coverage!.styles.some((entry) => entry.nativeTargets?.some((target) => target.role === 'button-link'))).toBe(true);
    }
    validateSourceContent(html, compileRegisteredBlock(plan).template);
  });

  it('binds the complete self-contained utility hero handoff through proposal and canonical-plan routes', async () => {
    const { html, sourcePath } = await source('utility/hero-handoff.html');
    const css = await readFile(path.join(benchmarkRoot, 'utility', 'hero.css'), 'utf8');
    const ref = refs(html);
    const proposal = { structure: [{ id: 'hero', block: 'core/group', sourceRef: ref('section'), children: [
      { id: 'hero-grid', block: 'core/group', sourceRef: ref('div', 0), children: [
        { id: 'copy', block: 'core/group', sourceRef: ref('div', 1), children: [
          { id: 'eyebrow', block: 'core/paragraph', sourceRef: ref('p', 0) },
          { id: 'title', block: 'core/heading', sourceRef: ref('h1') },
          { id: 'lede', block: 'core/paragraph', sourceRef: ref('p', 1) },
          { id: 'buttons', block: 'core/buttons', sourceRef: ref('div', 2), children: [
            { id: 'download', block: 'core/button', sourceRef: ref('a', 0) },
            { id: 'guide', block: 'core/button', sourceRef: ref('a', 1) },
          ] },
        ] },
        { id: 'image', block: 'core/image', sourceRef: ref('figure') },
      ] },
    ] }], fields: [
      { id: 'eyebrow-content', label: 'Eyebrow', mode: 'editable' as const, node: 'eyebrow', attribute: 'content' },
      { id: 'title-content', label: 'Title', mode: 'editable' as const, node: 'title', attribute: 'content' },
      { id: 'lede-content', label: 'Body', mode: 'editable' as const, node: 'lede', attribute: 'content' },
      { id: 'download-text', label: 'Download CTA', mode: 'editable' as const, node: 'download', attribute: 'text' },
      { id: 'guide-text', label: 'Guide CTA', mode: 'editable' as const, node: 'guide', attribute: 'text' },
      { id: 'image-url', label: 'Product image URL', mode: 'editable' as const, node: 'image', attribute: 'url' },
      { id: 'image-alt', label: 'Product image alt text', mode: 'editable' as const, node: 'image', attribute: 'alt' },
    ], locking: { mode: 'contentOnly' as const } };
    const options = {
      sourcePath,
      assetRoot: path.dirname(sourcePath),
      author: { name: 'block-runner/hero', styles: { mode: 'css' as const, css, foundation: 'component' as const } },
      proposal,
    };
    const first = await author(html, options);
    expect(first.ok, JSON.stringify(first.items)).toBe(true);
    const plan = first.package!.canonicalPlan!;
    const second = await author(html, options);
    expect(second.ok, JSON.stringify(second.items)).toBe(true);
    expect(plan).toEqual(second.package!.canonicalPlan);
    const nodes = nodesById(plan.structure);
    expect(nodes.get('eyebrow')!.attributes).toMatchObject({ content: 'Block Runner 0.9' });
    expect(nodes.get('title')!.attributes).toMatchObject({ content: 'Build a WordPress block your team can keep editing.' });
    expect(nodes.get('lede')!.attributes).toMatchObject({ content: 'Turn a finished interface into a registered block with clear controls, native markup, and a source trail reviewers can inspect.' });
    expect(nodes.get('download')!.attributes).toMatchObject({ text: 'Download the testing release', url: '/download' });
    expect(nodes.get('guide')!.attributes).toMatchObject({ text: 'Read the authoring guide', url: '/docs/authoring' });
    expect(nodes.get('image')!.attributes).toMatchObject({ alt: 'Aurora dashboard with color tokens, release receipts, and a completed activation check', caption: 'Native controls stay with the block, not in a screenshot.' });
    expect(plan.fields).toEqual([
      expect.objectContaining({ id: 'eyebrow-content', mode: 'editable', node: 'eyebrow', attribute: 'content' }),
      expect.objectContaining({ id: 'title-content', mode: 'editable', node: 'title', attribute: 'content' }),
      expect.objectContaining({ id: 'lede-content', mode: 'editable', node: 'lede', attribute: 'content' }),
      expect.objectContaining({ id: 'download-text', mode: 'editable', node: 'download', attribute: 'text' }),
      expect.objectContaining({ id: 'guide-text', mode: 'editable', node: 'guide', attribute: 'text' }),
      expect.objectContaining({ id: 'image-url', mode: 'editable', node: 'image', attribute: 'url' }),
      expect.objectContaining({ id: 'image-alt', mode: 'editable', node: 'image', attribute: 'alt' }),
    ]);
    expect(plan.sourceDecisions).toBeUndefined();
    expect(plan.source).toMatchObject({ entry: sourcePath });
    expect(plan.assets).toEqual(expect.arrayContaining([expect.objectContaining({
      source: path.join(path.dirname(sourcePath), 'assets/aurora-dashboard.svg'),
      uses: [expect.objectContaining({ node: 'image', attribute: 'url' })],
    })]));
    expect(plan.structure[0]!.children![0]!.children!.map((node) => node.id)).toEqual(['copy', 'image']);
    expect(plan.locking).toEqual({ mode: 'contentOnly' });
    const roundtrip = await author(html, {
      sourcePath,
      assetRoot: path.dirname(sourcePath),
      author: options.author,
      plan,
    });
    expect(roundtrip.ok, JSON.stringify(roundtrip.items)).toBe(true);
    expect(roundtrip.package!.canonicalPlan).toEqual(plan);
    validateSourceContent(html, compileRegisteredBlock(plan).template);
    const tampered = structuredClone(plan);
    tampered.coverage!.styles.find((entry) => entry.transportSelector && entry.nativeTargets?.length)!.transportSelector = '.unrelated-target';
    const rejected = await author(html, { sourcePath, assetRoot: path.dirname(sourcePath), author: options.author, plan: tampered });
    expect(rejected.ok).toBe(false);
    expect(rejected.package).toBeUndefined();
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
    const nodes = nodesById(plan.structure);
    expect(nodes.get('eyebrow')!.attributes).toMatchObject({ content: 'Testing release' });
    expect(nodes.get('title')!.attributes).toMatchObject({ content: 'Choose the review depth you need.', level: 2 });
    expect(nodes.get('intro')!.attributes).toMatchObject({ content: 'Every plan includes the generated source, the benchmark receipt, and editor verification.' });
    expect(nodes.get('starter')!.attributes).toMatchObject({ content: 'Starter', level: 3 });
    expect(nodes.get('team')!.attributes).toMatchObject({ content: 'Team', level: 3 });
    expect(nodes.get('studio')!.attributes).toMatchObject({ content: 'Studio', level: 3 });
    expect(nodes.get('starter-price')!.attributes).toMatchObject({ content: '<span class="amount">$0</span> / test site' });
    expect(nodes.get('starter-price-copy')!.attributes).toMatchObject({ content: 'Validate one registered block against the authoring suite.' });
    expect(nodes.get('badge')!.attributes).toMatchObject({ content: 'Recommended' });
    expect(nodes.get('team-price')!.attributes).toMatchObject({ content: '<span class="amount">$49</span> / month' });
    expect(nodes.get('team-price-copy')!.attributes).toMatchObject({ content: 'Package shared patterns with tracked style and activation receipts.' });
    expect(nodes.get('studio-price')!.attributes).toMatchObject({ content: '<span class="amount">Let’s talk</span>' });
    expect(nodes.get('studio-price-copy')!.attributes).toMatchObject({ content: 'Review larger pattern libraries and bespoke authoring workflows.' });
    expect(nodes.get('starter-link')!.attributes).toMatchObject({ text: 'Start testing', url: '/starter' });
    expect(nodes.get('team-link')!.attributes).toMatchObject({ text: 'Try Team', url: '/team' });
    expect(nodes.get('studio-link')!.attributes).toMatchObject({ text: 'Contact us', url: '/studio' });
    validateSourceContent(html, compileRegisteredBlock(plan).template);
  });

  it('keeps local assets, deterministic hashes, and the reviewed output path intact', async () => {
    const { html, sourcePath } = await source('semantic/local-assets.html');
    const assetSource = path.join(benchmarkRoot, 'assets', 'aurora-dashboard.svg');
    const assetBytes = await readFile(assetSource);
    const ref = refs(html);
    const proposal = { structure: [{ id: 'root', block: 'core/group', sourceRef: ref('section'), children: [
      { id: 'copy', block: 'core/group', sourceRef: ref('div'), children: [
        { id: 'eyebrow', block: 'core/paragraph', sourceRef: ref('p', 0) }, { id: 'title', block: 'core/heading', sourceRef: ref('h2') }, { id: 'body', block: 'core/paragraph', sourceRef: ref('p', 1) }, { id: 'buttons', block: 'core/buttons', children: [{ id: 'cta', block: 'core/button', sourceRef: ref('a') }] },
      ] }, { id: 'image', block: 'core/image', sourceRef: ref('figure') },
    ] }] };
    const options = { sourcePath, assetRoot: benchmarkRoot, author: { name: 'example/local-assets' }, proposal };
    const [first, second] = await Promise.all([author(html, options), author(html, options)]);
    expect(first.ok, JSON.stringify(first.items)).toBe(true);
    expect(second.ok).toBe(true);
    const plan = first.package!.canonicalPlan!;
    expect(plan).toEqual(second.package!.canonicalPlan);
    expect(hashAuthoringPlan(plan)).toBe(hashAuthoringPlan(second.package!.canonicalPlan!));
    const asset = plan.assets.find((candidate) => candidate.source === assetSource)!;
    expect(asset).toMatchObject({ source: assetSource, sha256: createHash('sha256').update(assetBytes).digest('hex'), destination: expect.stringMatching(/^assets\/aurora-dashboard-/), uses: [{ node: 'image', attribute: 'url' }] });
    expect(plan.structure[0]!.children![1]!.attributes).toMatchObject({ url: `./${asset.destination}`, alt: 'Aurora dashboard with color tokens, release receipts, and a completed activation check', caption: 'Local SVG fixture: no network asset may substitute for this file.' });
    expect(first.package!.assets).toEqual(expect.arrayContaining([expect.objectContaining({ path: asset.destination, sha256: asset.sha256 })]));
    const resubmitted = await author(html, { sourcePath, assetRoot: benchmarkRoot, author: { name: 'example/local-assets' }, plan });
    expect(resubmitted.ok, JSON.stringify(resubmitted.items)).toBe(true);
    const output = planRegisteredBlockOutput(plan);
    const parent = await mkdtemp(path.join(tmpdir(), 'block-runner-proposal-'));
    const destination = path.join(parent, 'not-yet-created');
    try {
      const inspection = await inspectAuthoringDestination(destination, output);
      await expect(access(destination)).rejects.toThrow();
      const confirmation = hashAuthoringConfirmation(plan, inspection);
      expect(renderAuthoringPreview(plan, { confirmationHash: confirmation })).toContain(confirmation);
      await expect(access(destination)).rejects.toThrow();
      const generated = compileRegisteredBlock(plan);
      expect(generated.assets).toContainEqual(expect.objectContaining({ path: asset.destination, content: assetBytes }));
      const written = await writeGeneratedRegisteredBlock(destination, generated, inspection);
      expect(written.written).toEqual(expect.arrayContaining(['block.json']));
      await expect(readFile(path.join(destination, asset.destination!))).resolves.toEqual(assetBytes);
    } finally { await rm(parent, { recursive: true, force: true }); }
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

  it('requires an explicit markup asset root for sibling assets and keeps that root contained', async () => {
    const assetBytes = await readFile(path.join(benchmarkRoot, 'assets', 'aurora-dashboard.svg'));
    const parent = await mkdtemp(path.join(tmpdir(), 'block-runner-asset-root-'));
    try {
      const sourceDirectory = path.join(parent, 'source');
      await mkdir(sourceDirectory);
      await writeFile(path.join(parent, 'private.svg'), assetBytes);
      const html = '<figure><img src="../private.svg" alt="Private"></figure>';
      const proposal = { structure: [{ id: 'image', block: 'core/image', sourceRef: refs(html)('figure') }] };
      const defaultBoundary = await author(html, {
        sourcePath: path.join(sourceDirectory, 'design.html'), author: { name: 'example/asset-root' }, proposal,
      });
      expect(defaultBoundary.ok).toBe(false);
      expect(defaultBoundary.package).toBeUndefined();
      expect(defaultBoundary.assets).toEqual(expect.arrayContaining([expect.objectContaining({ reference: '../private.svg', outcome: 'blocked' })]));

      const embeddedStyle = '<style>.hero { background-image: url("../private.svg"); }</style><section class="hero">Styled</section>';
      const embeddedStyleReport = await author(embeddedStyle, {
        sourcePath: path.join(sourceDirectory, 'design.html'), assetRoot: parent,
        author: { name: 'example/asset-root', styles: { mode: 'css' } },
        proposal: { structure: [{ id: 'hero', block: 'core/group', sourceRef: refs(embeddedStyle)('section') }] },
      });
      expect(embeddedStyleReport.ok, JSON.stringify(embeddedStyleReport.items)).toBe(true);
      expect(embeddedStyleReport.package!.canonicalPlan!.assets).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: path.join(parent, 'private.svg') }),
      ]));

      const authorizedRoot = path.join(parent, 'authorized');
      const nestedSource = path.join(authorizedRoot, 'source');
      await mkdir(nestedSource, { recursive: true });
      const escaped = await author('<figure><img src="../../private.svg" alt="Private"></figure>', {
        sourcePath: path.join(nestedSource, 'design.html'), assetRoot: authorizedRoot,
        author: { name: 'example/asset-root' }, proposal: { structure: [{ id: 'image', block: 'core/image', sourceRef: refs('<figure><img src="../../private.svg" alt="Private"></figure>')('figure') }] },
      });
      expect(escaped.ok).toBe(false);
      expect(escaped.package).toBeUndefined();
      expect(escaped.assets).toEqual(expect.arrayContaining([expect.objectContaining({ reference: '../../private.svg', outcome: 'blocked' })]));
    } finally { await rm(parent, { recursive: true, force: true }); }
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
