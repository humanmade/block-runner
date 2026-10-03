import { describe, expect, it } from 'vitest';
import { canonicalize, validate } from '../../src/index.js';

describe('gate', () => {
  const inline = '<!-- wp:paragraph --><p>Keep this content</p><!-- /wp:paragraph -->';
  const reference = `<!-- wp:block {"ref":123} -->${inline}<!-- /wp:block -->`;

  it.each([
    reference,
    `<!-- wp:group --><div class="wp-block-group">${reference}</div><!-- /wp:group -->`,
    '<!-- wp:block {"ref":123} --><p>Keep this content</p><!-- /wp:block -->',
  ])('rejects and preserves inline synced-pattern content during repair: %s', async (markup) => {
    const report = await validate(markup, { sourcePath: 'pattern.html' });
    expect(report.ok).toBe(false);
    expect(report.items).toContainEqual(expect.objectContaining({
      block: 'core/block', status: 'invalid',
      reason: expect.stringContaining('serialization would discard'),
      source: expect.objectContaining({ path: 'pattern.html' }),
    }));
    const fixed = await canonicalize(markup);
    expect(fixed.ok).toBe(false);
    expect(fixed.output).toBe(markup);
  });

  it('locates a malformed reference after an earlier valid reference', async () => {
    const report = await validate(`<!-- wp:block {"ref":123} /-->\n${reference}`);
    expect(report.items[0]?.source?.htmlLine).toBe(2);
  });

  it.each([
    '<!-- wp:block {"ref":123} /-->',
    '<!-- wp:block {"ref":123} --> \n <!-- /wp:block -->',
    '<!-- wp:block {"ref":123,"content":{"Text":{"content":"Custom text"}}} /-->',
    '<!-- wp:block {"ref":123,"overrides":{"Text":{"content":"Custom text"}}} /-->',
    '<!-- wp:block {"ref":123,"content":{"Text":{"values":{"content":"Custom text"}}}} /-->',
    `<!-- wp:group --><div class="wp-block-group">${inline}</div><!-- /wp:group -->`,
    '<!-- wp:paragraph {"metadata":{"name":"Text","bindings":{"__default":{"source":"core/pattern-overrides"}}}} --><p>Default</p><!-- /wp:paragraph -->',
  ])('preserves valid references, legacy overrides and pattern definitions: %s', async (markup) => {
    expect((await validate(markup)).ok).toBe(true);
    const fixed = await canonicalize(markup);
    expect(fixed.ok).toBe(true);
    if (markup.includes('Custom text')) {
      expect(fixed.output).toContain('"content":{"Text":{"content":"Custom text"}}');
    }
    if (markup.includes('Keep this content')) expect(fixed.output).toContain('Keep this content');
    if (markup.includes('Default')) expect(fixed.output).toContain('Default');
  });

  it('validates valid block markup', async () => {
    const report = await validate('<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->');

    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      blocks: 1,
      valid: 1,
      invalid: 0,
      warnings: 0,
    });
  });

  it('reports invalid block markup with source', async () => {
    const report = await validate('<!-- wp:paragraph --><h2>Hello</h2><!-- /wp:paragraph -->', {
      sourcePath: 'invalid.html',
    });

    expect(report.ok).toBe(false);
    expect(report.summary.invalid).toBe(1);
    expect(report.items[0]).toMatchObject({
      block: 'core/paragraph',
      status: 'invalid',
      source: {
        path: 'invalid.html',
        htmlLine: 1,
      },
    });
  });

  it('canonicalizes through serialize(parse()) and validates the output', async () => {
    const report = await canonicalize('<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->');

    expect(report.ok).toBe(true);
    expect(report.command).toBe('fix');
    expect(report.output).toContain('<!-- wp:paragraph -->');
  });

  it('keeps repair warnings attached to the authored input path', async () => {
    const report = await canonicalize(
      '<!-- wp:image --><img src="https://example.com/a.jpg" alt="A"/><!-- /wp:image -->',
      { sourcePath: 'authored.html' },
    );

    expect(report.items).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining('rebuilt from parsed attributes'),
      source: { path: 'blocks[0]' },
    }));
  });

  it('repairs a genuinely-invalid block by rebuilding from parsed attributes', async () => {
    // An image without its <figure> wrapper is invalid and has no matching
    // deprecation, so plain serialize(parse()) re-emits it still-broken.
    // Rebuilding from the parsed attributes re-runs save() and produces valid
    // markup with the wrapper.
    const report = await canonicalize(
      '<!-- wp:image --><img src="https://example.com/a.jpg" alt="A"/><!-- /wp:image -->',
    );

    expect(report.ok).toBe(true);
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('wp-block-image');
    expect(report.output).toContain('https://example.com/a.jpg');
    expect(report.items).toContainEqual(expect.objectContaining({ status: 'warning', reason: expect.stringContaining('rebuilt from parsed attributes') }));
  });

  it('does not silently discard text outside the attributes recognised by the native block', async () => {
    const markup = '<!-- wp:image --><figure><img src="https://example.com/a.jpg" alt="A"/><p>Important caption</p></figure><!-- /wp:image -->';
    const report = await canonicalize(markup);
    expect(report.ok).toBe(false);
    expect(report.output).toContain('Important caption');
    expect(report.items).toContainEqual(expect.objectContaining({ status: 'warning', reason: expect.stringContaining('left unchanged') }));
  });

  it('leaves unregistered blocks untouched while repairing invalid core blocks', async () => {
    const markup =
      '<!-- wp:acme/widget {"n":1} /-->' +
      '<!-- wp:image --><img src="https://example.com/b.jpg" alt="B"/><!-- /wp:image -->';
    const report = await canonicalize(markup);

    // The custom block round-trips verbatim; the core image is repaired.
    expect(report.output).toContain('wp:acme/widget');
    expect(report.output).toContain('wp-block-image');
  });
});
