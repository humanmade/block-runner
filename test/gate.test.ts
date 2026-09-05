import { describe, expect, it } from 'vitest';
import { canonicalize, validate } from '../src/index.js';

describe('gate', () => {
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
