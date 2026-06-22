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
});
