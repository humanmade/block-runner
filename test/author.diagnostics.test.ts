import { describe, expect, it } from 'vitest';
import { author, collectSourceEvidence } from '../src/index.js';
import { AuthorDiagnosticError } from '../src/author/diagnostics.js';
import { validateCoverageFulfillment } from '../src/author/plan.js';
import type { AuthoringCoverageStyle, AuthoringPlan } from '../src/authoring/schema.js';

function sourceRef(html: string, tag: string): string {
  return collectSourceEvidence(html).structure.find((entry) => entry.tag === tag)!.sourceRef!;
}

describe('author diagnostics', () => {
  it('locates stale proposal references without treating their old hash as a current binding', async () => {
    const html = '<p>Hello</p>';
    const report = await author(html, {
      sourcePath: '/tmp/block-runner-diagnostic/stale.html',
      author: { name: 'example/diagnostic-stale' },
      proposal: { structure: [{ id: 'copy', block: 'core/paragraph', sourceRef: `${'0'.repeat(64)}:0-12` }] },
    });
    const item = report.items[0]!;
    expect(report.ok).toBe(false);
    expect(item).toMatchObject({ code: 'stale-proposal-source-ref', source: { path: '/tmp/block-runner-diagnostic/stale.html' } });
    expect(item.source).not.toHaveProperty('offset');
    expect(item.reason).not.toMatch(/offset|stale\.html:/i);
    expect(item.details).toMatchObject({ sourceRef: `${'0'.repeat(64)}:0-12`, node: 'copy', action: 'refresh-source-analysis', referenceVerified: false });
    expect(JSON.parse(JSON.stringify(report)).items[0].reason).toMatch(/stale, missing, or belongs to another source/i);
  });

  it('reports deterministic coverage differences and resolves them when the canonical plan is restored', async () => {
    const html = '<p class="notice">Hello</p>';
    const options = { author: { name: 'example/diagnostic-coverage', styles: { mode: 'css' as const, css: '.notice { color: red; }' } } };
    const resolved = await author(html, options);
    expect(resolved.ok, JSON.stringify(resolved.items)).toBe(true);
    const rejectedPlan = structuredClone(resolved.package!.canonicalPlan!);
    rejectedPlan.coverage!.styles = [];
    const first = await author(html, { ...options, plan: rejectedPlan });
    const second = await author(html, { ...options, plan: rejectedPlan });
    expect(first.ok).toBe(false);
    expect(first.items).toEqual(second.items);
    const item = first.items.find((candidate) => candidate.code === 'coverage-missing-declaration')!;
    expect(item).toMatchObject({ source: { selector: '.notice', htmlLine: 1, htmlColumn: 11 } });
    expect(item.reason).toMatch(/complete source declaration and asset coverage.*Missing declaration/i);
    expect(item.details).toMatchObject({ action: expect.stringMatching(/semantic proposal through author/i), total: expect.any(Number), truncated: expect.any(Number) });
    const corrected = await author(html, { ...options, plan: resolved.package!.canonicalPlan! });
    expect(corrected.ok, JSON.stringify(corrected.items)).toBe(true);

    const duplicate = structuredClone(resolved.package!.canonicalPlan!);
    duplicate.coverage!.styles.push(structuredClone(duplicate.coverage!.styles[0]!));
    const duplicateReport = await author(html, { ...options, plan: duplicate });
    const duplicateItem = duplicateReport.items.find((candidate) => candidate.code === 'coverage-changed-context')!;
    expect(duplicateItem.details).toMatchObject({ key: expect.stringMatching(/order/), observed: expect.any(Object) });
    expect((duplicateItem.details as Record<string, unknown>).observed).not.toHaveProperty('styles');
  });

  it('reports an unmatched emitted selector with its declaration source', async () => {
    const html = '<p class="notice">Hello</p>';
    const options = { author: { name: 'example/diagnostic-selector', styles: { mode: 'css' as const, css: '.notice:hover { color: red; }' } } };
    const baseline = await author(html, options);
    const plan = structuredClone(baseline.package!.canonicalPlan!);
    plan.structure[0]!.attributes = {};
    const report = await author(html, { ...options, plan });
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'coverage-unmatched-emitted-selector', source: expect.objectContaining({ selector: '.notice:hover' }), details: expect.objectContaining({ property: 'color', action: expect.any(String) }) }),
    ]));
  });

  it('names changed values, conditions, and ownership without asking for a coverage ledger', async () => {
    const html = '<p class="notice">Hello</p>';
    const options = { author: { name: 'example/diagnostic-changes', styles: { mode: 'css' as const, css: '.notice { color: red; }' } } };
    const baseline = await author(html, options);
    const change = (mutate: (entry: AuthoringCoverageStyle) => void) => {
      const plan = structuredClone(baseline.package!.canonicalPlan!);
      const entry = plan.coverage!.styles.find((candidate) => candidate.source?.selector === '.notice')!;
      mutate(entry);
      return author(html, { ...options, plan });
    };
    for (const [label, mutate, code] of [
      ['value', (entry: AuthoringCoverageStyle) => { entry.value = 'blue'; }, 'coverage-changed-declaration'],
      ['condition', (entry: AuthoringCoverageStyle) => { entry.atRules = ['@media (min-width: 1px)']; }, 'coverage-changed-declaration'],
      ['ownership', (entry: AuthoringCoverageStyle) => { entry.outcome = 'scoped-css'; }, 'coverage-contradictory-declaration-ownership'],
    ] as const) {
      const report = await change(mutate);
      const item = report.items.find((candidate) => candidate.code === code)!;
      expect(item.reason, label).toMatch(/declaration color: red/i);
      expect(item.details).toMatchObject({ expected: expect.objectContaining({ property: 'color', value: 'red' }), observed: expect.any(Object) });
    }
  });

  it('caps large coverage sets while retaining total and category visibility', async () => {
    const html = Array.from({ length: 13 }, (_, index) => `<p class="c${index}">Item ${index}</p>`).join('');
    const css = Array.from({ length: 13 }, (_, index) => `.c${index} { color: red; }`).join('\n');
    const options = { author: { name: 'example/diagnostic-cap', styles: { mode: 'css' as const, css } } };
    const baseline = await author(html, options);
    expect(baseline.ok, JSON.stringify(baseline.items)).toBe(true);
    const plan = structuredClone(baseline.package!.canonicalPlan!);
    plan.coverage!.styles = [];
    const report = await author(html, { ...options, plan });
    const diagnostics = report.items.filter((item) => item.code?.startsWith('coverage-'));
    expect(diagnostics).toHaveLength(12);
    expect(diagnostics[0]!.details).toMatchObject({ total: expect.any(Number), truncated: expect.any(Number), categories: ['coverage-missing-declaration'] });
    const details = diagnostics[0]!.details as { total: number; truncated: number };
    expect(details.total).toBeGreaterThan(12);
    expect(details.truncated).toBe(details.total - 12);
  });

  it('does not mistake a node named ENOENT for a host failure', async () => {
    const html = '<p>Original</p>';
    const report = await author(html, {
      author: { name: 'example/diagnostic-name' },
      proposal: { structure: [{ id: 'ENOENT', block: 'core/paragraph', sourceRef: sourceRef(html, 'p'), attributes: { content: 'Changed' } }] },
    });
    expect(report.ok).toBe(false);
    expect(report.items[0]!.reason).toContain('changes source content');
    expect(report.items[0]!.code).not.toBe('author-environment-input');
  });

  it('distinguishes a missing local stylesheet dependency from a design correction', async () => {
    const missing = 'definitely-missing-author-input.css';
    const report = await author('<p>Hello</p>', {
      sourcePath: '/tmp/block-runner-diagnostic/design.html',
      author: { name: 'example/diagnostic-environment', styles: { mode: 'tailwind', tailwind: {
        cssEntries: [missing], imports: [], directives: [], sources: ['design.html'], safelist: [], plugins: [], environment: {}, browserTarget: 'defaults',
        compiler: { name: 'tailwindcss', version: 'test', compile: () => '' },
      } } },
    });
    const item = report.items.find((candidate) => candidate.code === 'author-environment-input')!;
    expect(item, JSON.stringify(report.items)).toBeDefined();
    expect(item.reason).toMatch(/ENOENT.*definitely-missing-author-input\.css/i);
    expect(item.details).toMatchObject({ classification: 'environment', hostCode: 'ENOENT', path: expect.stringMatching(/definitely-missing-author-input\.css$/), action: expect.stringMatching(/do not rewrite the design/i) });
  });

  it('keeps missing asset uses and unsupported mappings machine-readable', async () => {
    const plan: AuthoringPlan = {
      version: 1, generatorVersion: '0.9.0', target: { name: 'example/diagnostic-asset', title: 'Asset' },
      source: { entry: '/tmp/diagnostic/design.html', sha256: '0'.repeat(64), format: 'html' },
      coverage: { styles: [], assets: [{ reference: 'image.png', kind: 'image', outcome: 'prepared', sha256: '1'.repeat(64), destination: 'assets/image.png', source: { path: '/tmp/diagnostic/design.html', offset: 4 } }] },
      structure: [], fields: [], locking: { mode: 'none' }, styles: { strategy: 'native', outcomes: [] }, pattern: { ready: false, overrides: [] }, files: [], warnings: [],
      assets: [{ id: 'image', source: '/tmp/diagnostic/image.png', destination: 'assets/image.png', sha256: '1'.repeat(64), uses: [] }],
    };
    try {
      validateCoverageFulfillment(plan, '<img src="image.png">', '/tmp/diagnostic');
      throw new Error('expected missing asset use');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorDiagnosticError);
      expect((error as AuthorDiagnosticError).diagnostics[0]).toMatchObject({ code: 'coverage-missing-asset-use', source: { offset: 4 }, details: { reference: 'image.png', action: expect.any(String) } });
    }

    const html = '<div><a class="move" href="/go">Go</a></div>';
    const report = await author(html, {
      author: { name: 'example/diagnostic-unsupported', styles: { mode: 'css', css: 'div .move:hover { color: red; }' } },
      proposal: { structure: [{ id: 'group', block: 'core/group', sourceRef: sourceRef(html, 'div') }, { id: 'button', block: 'core/button', sourceRef: sourceRef(html, 'a') }] },
    });
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'invalid-proposal-relationship',
        details: expect.objectContaining({ requiredRelationship: { parentBlock: 'core/buttons', relationship: 'direct-child' }, action: 'place-core-button-under-core-buttons', stage: 'final-proposal' }),
      }),
    ]));
  });

  it('keeps source analysis visible when a final proposal relationship is rejected', async () => {
    const html = '<a href="/go">Go</a><figure><img src="https://example.test/photo.jpg" alt="Photo"><figcaption><svg viewBox="0 0 2 2"><rect/></svg></figcaption></figure>';
    const proposal = { structure: [{ id: 'cta', block: 'core/button', sourceRef: sourceRef(html, 'a') }] };
    const options = { author: { name: 'example/diagnostic-stages' }, proposal };
    const [first, second] = await Promise.all([author(html, options), author(html, options)]);
    expect(first.ok).toBe(false);
    expect(first.package).toBeUndefined();
    expect(first.items).toEqual(second.items);
    expect(first.items.find((item) => /Custom HTML fallback/i.test(item.reason)))
      .toMatchObject({ details: { stage: 'intermediate', phase: 'source-analysis' } });
    expect(first.items.find((item) => item.code === 'invalid-proposal-relationship')).toMatchObject({
      source: { offset: 0 },
      details: {
        sourceRef: sourceRef(html, 'a'),
        node: 'cta',
        selectedParent: null,
        requiredRelationship: { parentBlock: 'core/buttons', relationship: 'direct-child' },
        action: 'place-core-button-under-core-buttons',
        stage: 'final-proposal',
      },
    });
  });

  it('names the core/image correction for a figure bound to an incompatible block', async () => {
    const html = '<figure><img src="https://example.test/photo.jpg" alt="Photo"></figure>';
    const report = await author(html, {
      author: { name: 'example/diagnostic-figure' },
      proposal: { structure: [{ id: 'layout', block: 'core/columns', sourceRef: sourceRef(html, 'figure') }] },
    });
    expect(report.ok).toBe(false);
    expect(report.package).toBeUndefined();
    expect(report.items.find((item) => item.code === 'incompatible-proposal-source-binding')).toMatchObject({
      source: { offset: 0 },
      details: {
        sourceRef: sourceRef(html, 'figure'), node: 'layout', block: 'core/columns', requiredBlock: 'core/image',
        action: 'replace-with-core-image', stage: 'final-proposal',
      },
    });
  });
});
