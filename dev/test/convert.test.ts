import { describe, expect, it } from 'vitest';
import { convert } from '../../src/index.js';
import type { Rule } from '../../src/types.js';

const heroHtml = String.raw`
<!-- wp:html -->
<section class="hero" aria-label="Launch hero">
  <style>
    .hero__bg{background-image:url(hero.jpg)}
  </style>
  <div class="hero__bg" aria-hidden="true"></div>
  <div class="hero__row">
    <div class="hero__column">
      <p class="hero__eyebrow">Launch faster</p>
      <h1>Design HTML to editable blocks</h1>
      <p>Convert authored sections into native Gutenberg markup.</p>
      <a class="hero__cta" href="/start">Start now</a>
    </div>
    <div class="hero__column">
      <h2>Built for handoff</h2>
      <p>Validate and canonicalize before publishing.</p>
    </div>
  </div>
</section>
<!-- /wp:html -->
`;

describe('convert', () => {
  it('rejects synced-pattern children emitted by a custom rule', async () => {
    const rule: Rule = {
      id: 'pattern-reference',
      match: (node) => node.tagName === 'SECTION',
      emit: async (_node, context) => context.wp.createBlock('core/block', { ref: 123 }, [
        context.wp.createBlock('core/paragraph', { content: 'Keep this content' }),
      ]),
    };
    const report = await convert('<section>Keep this content</section>', {
      sourcePath: 'design.html',
      config: { rules: { custom: [rule] } },
    });
    expect(report.ok).toBe(false);
    expect(report.output).toBe('');
    expect(report.items).toContainEqual(expect.objectContaining({
      block: 'core/block', status: 'invalid',
      source: expect.objectContaining({ path: 'design.html', htmlLine: 1 }),
    }));
  });

  it('converts a CSS-background hero to native cover content without Custom HTML', async () => {
    const report = await convert(heroHtml, {
      sourcePath: 'hero.html',
      config: {
        media: {
          resolver: 'map',
          map: {
            'hero.jpg': {
              id: 42,
              url: 'https://example.test/uploads/hero.jpg',
            },
          },
        },
      },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('wp:cover');
    expect(report.output).toContain('wp:columns');
    expect(report.output).toContain('wp:column');
    expect(report.output).toContain('wp:heading');
    expect(report.output).toContain('wp:buttons');
    expect(report.output).toContain('wp:button');
    expect(report.output).not.toContain('wp:html');
    expect(report.output).toContain('"id":42');
    expect(report.summary.invalid).toBe(0);
    expect(report.items.some((item) => item.reason.includes('<style> stripped'))).toBe(true);
  });

  it('fails strict conversion when a fallback block is needed', async () => {
    const report = await convert('<iframe src="https://example.test/embed"></iframe>', {
      strict: true,
      sourcePath: 'embed.html',
    });

    expect(report.ok).toBe(false);
    expect(report.output).toContain('wp:html');
    expect(report.items.some((item) => item.reason.includes('Custom HTML fallback'))).toBe(true);
  });

  it('selects one exact authored static page and reports source-only export limits', async () => {
    const report = await convert(
      `<x-dc>\n` +
        `  <helmet>kept metadata</helmet>\n` +
        `  <sc-if data-dc-static>\n` +
        `    <section data-document-role="page" data-canvas-width="1200" data-canvas-height="800">\n` +
        `      <canvas>fallback child</canvas>\n` +
        `      <span>{{title}}</span>\n` +
        `    </section>\n` +
        `  </sc-if>\n` +
        `  <div data-canvas-width="1200" data-canvas-height="800">runtime page</div>\n` +
        `  <aside>kept sibling</aside>\n` +
        `</x-dc>`,
      { sourcePath: 'export.html' },
    );

    expect(report.output).toContain('data-document-role="page"');
    expect(report.output).toContain('fallback child');
    expect(report.output).toContain('kept metadata');
    expect(report.output).toContain('kept sibling');
    expect(report.output).not.toContain('runtime page');
    expect(report.items).toContainEqual(expect.objectContaining({
      status: 'warning',
      reason: 'authored static alternative selected; runtime behavior is not carried',
      source: expect.objectContaining({ path: 'export.html', htmlLine: 1 }),
    }));
    expect(report.items).toContainEqual(expect.objectContaining({
      status: 'warning',
      reason: 'unresolved {{...}} binding remains in authored markup',
      source: expect.objectContaining({ path: 'export.html', htmlLine: 6 }),
    }));
    expect(report.items).toContainEqual(expect.objectContaining({
      status: 'warning',
      reason: 'canvas pixels are runtime-managed; authored fallback children are preserved',
      source: expect.objectContaining({ path: 'export.html', htmlLine: 5 }),
    }));
  });

  it('preserves ambiguous exports and leaves ordinary markup unchanged', async () => {
    const ambiguous = await convert(
      `<x-dc><sc-if data-dc-static><section data-document-role="page" data-canvas-width="900" data-canvas-height="600">static</section></sc-if>` +
        `<div data-canvas-width="900" data-canvas-height="600">first</div><div data-canvas-width="900" data-canvas-height="600">second</div></x-dc>`,
    );
    expect(ambiguous.output).toContain('static');
    expect(ambiguous.output).toContain('first');
    expect(ambiguous.output).toContain('second');
    expect(ambiguous.items).toContainEqual(expect.objectContaining({
      reason: 'authored static alternative is ambiguous; original export markup was preserved',
    }));

    const ordinary = await convert('<main><p>ordinary template</p><canvas>plain fallback</canvas><span>{{plain}}</span></main>');
    expect(ordinary.output).toContain('ordinary template');
    expect(ordinary.items.some((item) => /authored static alternative|runtime-managed|unresolved \{\{/.test(item.reason))).toBe(false);
  });

  it('reports explain attribution without counting explain entries as warnings', async () => {
    const report = await convert('<p>Hello</p>', {
      explain: true,
    });

    expect(report.ok).toBe(true);
    expect(report.summary.warnings).toBe(0);
    expect(report.items.some((item) => item.details && (item.details as { explainOnly?: boolean }).explainOnly)).toBe(
      true,
    );
  });

  it('preserves list items as nested list-item blocks', async () => {
    const report = await convert('<ul><li>One</li><li><strong>Two</strong></li></ul>');

    expect(report.ok).toBe(true);
    expect(report.output).toContain('wp:list');
    expect(report.output).toContain('wp:list-item');
    expect(report.output).toContain('<li>One</li>');
    expect(report.output).toContain('<li><strong>Two</strong></li>');
    expect(report.output).not.toContain('<ul class="wp-block-list"></ul>');
  });

  it('preserves an authored outer heading ID as its native anchor', async () => {
    const report = await convert('<h2 id="details">Details</h2><a href="#details">Read details</a>', { resolver: 'noop' });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('"anchor":"details"');
    expect(report.output).toContain('id="details"');
    expect(report.output).toContain('href="#details"');
  });
});
