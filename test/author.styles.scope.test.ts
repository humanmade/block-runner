import { describe, expect, it } from 'vitest';
import { nativeSelectorSubjects, scanStylesheet, scopeLocalSelectorList } from '../src/author/styles.js';

describe('component CSS selector scoping', () => {
  it('reads complete escaped utility atoms without accepting a longer suffix atom', () => {
    const subjects = nativeSelectorSubjects('.focus-visible\\:outline:focus-visible, .focus-visible\\:outline-2:focus-visible');
    expect(subjects?.map((subject) => subject.classes[0]!.decoded)).toEqual(['focus-visible:outline', 'focus-visible:outline-2']);
    expect(subjects?.[0]?.classes[0]?.raw).toBe('.focus-visible\\:outline');
    expect(nativeSelectorSubjects('.card > .cta')).toBeUndefined();
  });

  it('uses a zero-specificity root boundary while retaining local selector states and lists', () => {
    const scoped = scopeLocalSelectorList(':where(.card), .card:hover::before', '.wp-block-acme-card');

    expect(scoped).toEqual({
      ok: true,
      selector: ':where(.wp-block-acme-card) :where(.card), :where(.wp-block-acme-card) .card:hover::before',
    });
  });

  it('keeps escaped selector commas and exact raw declaration value ranges in shared facts', () => {
    const css = [
      '/* heading */',
      '.thing\\,part, .two { background-image: url("a,b.png"); color:',
      '  /* palette: decoy */',
      '  red !important; }',
    ].join('\n');
    const stylesheet = scanStylesheet(css);
    const rule = stylesheet.rules[0]!;
    expect(rule.kind).toBe('style');
    if (rule.kind !== 'style') return;
    // Escaped selector atoms are retained in the source facts; the conservative scoper may
    // explicitly reject selector syntax it cannot prove safe rather than rewriting it.
    expect(scopeLocalSelectorList(rule.selector, '.wp-block-acme-card').ok).toBe(false);
    expect(css.slice(rule.declarations[0]!.valueSource.start.offset, rule.declarations[0]!.valueSource.end.offset)).toBe('url("a,b.png")');
    expect(css.slice(rule.declarations[1]!.valueSource.start.offset, rule.declarations[1]!.valueSource.end.offset)).toBe('/* palette: decoy */\n  red !important');
    expect(rule.declarations[1]!.valueSource.start).toMatchObject({ line: 3, column: 3 });
    expect(stylesheet.ledger).toHaveLength(2);
  });
});
