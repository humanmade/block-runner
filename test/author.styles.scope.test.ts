import { describe, expect, it } from 'vitest';
import { scopeLocalSelectorList } from '../src/author/styles.js';

describe('component CSS selector scoping', () => {
  it('uses a zero-specificity root boundary while retaining local selector states and lists', () => {
    const scoped = scopeLocalSelectorList(':where(.card), .card:hover::before', '.wp-block-acme-card');

    expect(scoped).toEqual({
      ok: true,
      selector: ':where(.wp-block-acme-card) :where(.card), :where(.wp-block-acme-card) .card:hover::before',
    });
  });
});
