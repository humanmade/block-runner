import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalize } from '../src/index.js';
import { createTokenResolver } from '../src/tokens/resolver.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const groupBg = (hex: string) =>
  `<!-- wp:group {"style":{"color":{"background":"${hex}"}}} --><div class="wp-block-group has-background" style="background-color:${hex}"><!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph --></div><!-- /wp:group -->`;

// Like groupBg but with the raw class Gutenberg emits for a hardcoded inline
// background — no `has-background`. This is what real authored/AI markup looks
// like; the repaired attributes must reach the rendered save() output, which only
// happens if the repaired tree is rebuilt before serialize (a parsed block reuses
// its original innerHTML otherwise, so the preset class would never appear and the
// block would be left invalid).
const rawGroupBg = (hex: string) =>
  `<!-- wp:group {"style":{"color":{"background":"${hex}"}}} -->\n<div class="wp-block-group" style="background-color:${hex}"><!-- wp:paragraph -->\n<p>Brand block</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->`;

describe('token repair', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('repairs an exact hex background to a preset slug', async () => {
    const report = await canonicalize(groupBg('#0073aa'), {
      config: { tokens: { colors: { primary: '#0073aa' } } },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('has-primary-background-color');
    expect(report.output).not.toContain('#0073aa');
    expect(report.items.some((item) => item.rule === 'token-repair')).toBe(true);
  });

  it('re-saves the repaired tree so a fixed block stays valid (fix path)', async () => {
    const report = await canonicalize(rawGroupBg('#0073aa'), {
      config: { tokens: { colors: { primary: '#0073aa' } } },
    });

    expect(report.ok).toBe(true);
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('"backgroundColor":"primary"');
    expect(report.output).toContain('has-primary-background-color has-background');
    expect(report.output).not.toContain('#0073aa');
    expect(report.output).not.toContain('background-color:');
  });

  it('re-saves a repaired font size (fix path)', async () => {
    const markup =
      '<!-- wp:heading {"style":{"typography":{"fontSize":"32px"}}} -->\n<h2 class="wp-block-heading" style="font-size:32px">Title</h2>\n<!-- /wp:heading -->';
    const report = await canonicalize(markup, {
      config: { tokens: { fontSizes: { large: '32px' } } },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('"fontSize":"large"');
    expect(report.output).toContain('has-large-font-size');
    expect(report.output).not.toContain('font-size:32px');
  });

  it('re-saves a repaired spacing value (fix path)', async () => {
    const markup =
      '<!-- wp:group {"style":{"spacing":{"padding":{"top":"clamp(1.5rem, 5vw, 3rem)"}}}} -->\n<div class="wp-block-group" style="padding-top:clamp(1.5rem, 5vw, 3rem)"><!-- wp:paragraph -->\n<p>Hi</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->';
    const report = await canonicalize(markup, {
      config: { tokens: { spacing: { '40': 'clamp(1.5rem, 5vw, 3rem)' } } },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('var:preset|spacing|40');
    expect(report.output).toContain('var(--wp--preset--spacing--40)');
  });

  it('leaves a non-matching hex untouched', async () => {
    const report = await canonicalize(groupBg('#abcdef'), {
      config: { tokens: { colors: { primary: '#0073aa' } } },
    });

    expect(report.output).toContain('#abcdef');
    expect(report.output).not.toContain('has-primary-background-color');
  });

  it('repairs a font size to a preset slug', async () => {
    const markup =
      '<!-- wp:paragraph {"style":{"typography":{"fontSize":"32px"}}} --><p style="font-size:32px">Hi</p><!-- /wp:paragraph -->';
    const report = await canonicalize(markup, {
      config: { tokens: { fontSizes: { large: '32px' } } },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('has-large-font-size');
    expect(report.output).not.toContain('font-size:32px');
  });

  it('repairs a font family to a preset slug', async () => {
    const markup =
      '<!-- wp:paragraph {"style":{"typography":{"fontFamily":"Inter, sans-serif"}}} --><p style="font-family:Inter, sans-serif">Hi</p><!-- /wp:paragraph -->';
    const report = await canonicalize(markup, {
      config: { tokens: { fonts: { body: 'Inter, sans-serif' } } },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('has-body-font-family');
  });

  it('repairs a hardcoded spacing value to a preset reference', async () => {
    const markup =
      '<!-- wp:group {"style":{"spacing":{"padding":{"top":"clamp(1.5rem, 5vw, 3rem)"}}}} --><div class="wp-block-group" style="padding-top:clamp(1.5rem, 5vw, 3rem)"><!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph --></div><!-- /wp:group -->';
    const report = await canonicalize(markup, {
      config: { tokens: { spacing: { '40': 'clamp(1.5rem, 5vw, 3rem)' } } },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('var(--wp--preset--spacing--40)');
  });

  it('snaps a near color in nearest mode but not in exact mode', async () => {
    const near = await canonicalize(groupBg('#0074ab'), {
      config: { tokens: { colors: { primary: '#0073aa' }, match: 'nearest' } },
    });
    expect(near.output).toContain('has-primary-background-color');

    const exact = await canonicalize(groupBg('#0074ab'), {
      config: { tokens: { colors: { primary: '#0073aa' } } },
    });
    expect(exact.output).toContain('#0074ab');
    expect(exact.output).not.toContain('has-primary-background-color');
  });

  it('is a no-op when no tokens are configured', async () => {
    const report = await canonicalize(groupBg('#0073aa'));

    expect(report.output).toContain('#0073aa');
    expect(report.output).not.toContain('has-primary-background-color');
  });
});

describe('token resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('repairs through the file resolver against a theme.json fixture', async () => {
    const report = await canonicalize(groupBg('#0073aa'), {
      config: { tokens: { resolver: 'file', themeJson: path.join(FIXTURES, 'theme.json') } },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('has-primary-background-color');
  });

  it('repairs spacing and font size through the file resolver (not just color)', async () => {
    // Regression: the schema default `tokens.spacing = []` must not shadow the
    // resolver's spacing value-map. Drives all three token kinds end-to-end
    // through the file resolver, where only color was covered before.
    const markup =
      '<!-- wp:heading {"style":{"typography":{"fontSize":"32px"},"spacing":{"padding":{"top":"clamp(1.5rem, 5vw, 3rem)"}}}} -->\n' +
      '<h2 class="wp-block-heading" style="font-size:32px;padding-top:clamp(1.5rem, 5vw, 3rem)">T</h2>\n' +
      '<!-- /wp:heading -->';
    const report = await canonicalize(markup, {
      config: { tokens: { resolver: 'file', themeJson: path.join(FIXTURES, 'theme.json') } },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('has-large-font-size');
    expect(report.output).toContain('var:preset|spacing|40');
    expect(report.output).not.toContain('32px');
  });

  it('repairs through the context resolver against a site.context.json fixture', async () => {
    // No explicit tokenResolver — a provided --context must implicitly select
    // the 'context' resolver and repair from the manifest's theme settings slice.
    const report = await canonicalize(rawGroupBg('#0073aa'), {
      context: path.join(FIXTURES, 'site.context.json'),
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('has-primary-background-color');
    expect(report.output).not.toContain('#0073aa');
  });

  it('parses fonts and font sizes distinctly from the manifest theme.settings slice', async () => {
    const tokens = await createTokenResolver(
      {},
      { tokenResolver: 'context', context: path.join(FIXTURES, 'site.context.json') },
    ).resolve();

    expect(tokens.colors).toMatchObject({ primary: '#0073aa' });
    expect(tokens.fonts).toMatchObject({ body: 'Inter, sans-serif' });
    expect(tokens.fontSizes).toMatchObject({ large: '2rem' });
    expect(tokens.spacing).toMatchObject({ '40': '1.5rem' });
  });

  it('fails open to empty tokens when the context manifest is missing or malformed', async () => {
    const missing = await createTokenResolver(
      {},
      { tokenResolver: 'context', context: path.join(FIXTURES, 'does-not-exist.json') },
    ).resolve();
    expect(missing).toEqual({ colors: {}, fonts: {}, fontSizes: {}, spacing: {} });

    const malformed = await createTokenResolver(
      {},
      { tokenResolver: 'context', context: path.join(FIXTURES, 'theme.json') },
    ).resolve();
    // theme.json has no top-level `theme.settings`, so the context resolver yields nothing.
    expect(malformed).toEqual({ colors: {}, fonts: {}, fontSizes: {}, spacing: {} });
  });

  it('resolves theme tokens from the REST API', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/wp/v2/themes')) {
        return new Response(JSON.stringify([{ stylesheet: 'twentytwentyfive' }]), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          settings: {
            color: { palette: [{ slug: 'primary', color: '#0073aa' }] },
            typography: {
              fontFamilies: [{ slug: 'body', fontFamily: 'Inter, sans-serif' }],
              fontSizes: [{ slug: 'large', size: '32px' }],
            },
            spacing: { spacingSizes: [{ slug: '40', size: 'clamp(1.5rem, 5vw, 3rem)' }] },
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolver = createTokenResolver(
      { media: { wpUrl: 'https://example.test' }, tokens: { resolver: 'rest' } },
      { tokenResolver: 'rest' },
    );
    const resolved = await resolver.resolve();

    expect(resolved).toEqual({
      colors: { primary: '#0073aa' },
      fonts: { body: 'Inter, sans-serif' },
      fontSizes: { large: '32px' },
      spacing: { '40': 'clamp(1.5rem, 5vw, 3rem)' },
    });
  });
});
