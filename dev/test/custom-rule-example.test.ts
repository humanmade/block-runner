import { describe, expect, it } from 'vitest';
// @ts-expect-error The shipped JavaScript config intentionally has no declaration file.
import config from '../../examples/custom-rule.mjs';
import { convert } from '../../src/index.js';

describe('custom rule example', () => {
  it('converts only marked paragraphs to a native notice paragraph', async () => {
    const marked = await convert('<p data-notice>Service update</p>', { config });
    const unmarked = await convert('<p>Routine update</p>', { config });

    expect(marked.ok).toBe(true);
    expect(marked.summary.invalid).toBe(0);
    expect(marked.output).toContain('wp:paragraph');
    expect(marked.output).toContain('className":"notice"');
    expect(marked.output).toContain('Service update');
    expect(marked.output).not.toContain('wp:html');
    expect(marked.items.some((item) => item.reason.includes('Custom HTML fallback'))).toBe(false);

    expect(unmarked.ok).toBe(true);
    expect(unmarked.summary.invalid).toBe(0);
    expect(unmarked.output).toContain('wp:paragraph');
    expect(unmarked.output).toContain('Routine update');
    expect(unmarked.output).not.toContain('className":"notice"');
    expect(unmarked.output).not.toContain('wp:html');
    expect(unmarked.items.some((item) => item.reason.includes('Custom HTML fallback'))).toBe(false);
  });
});
