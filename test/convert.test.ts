import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';

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
});
