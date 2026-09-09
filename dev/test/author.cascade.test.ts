import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { baseStyleDeclarationIdsRequiringScopedCss, hasUnsafeResponsiveNativeCascade } from '../../src/author/cascade.js';
import { scanStylesheet } from '../../src/author/styles.js';

function conflict(html: string, css: string, property = 'color'): boolean {
  const rules = scanStylesheet(css).rules;
  const first = rules.find((rule) => rule.kind === 'style')!;
  const declaration = first.declarations.find((item) => item.property === property)!;
  return hasUnsafeResponsiveNativeCascade({
    document: new JSDOM(html).window.document,
    rules,
    candidate: { selector: '.candidate', declarationId: declaration.id, property },
  });
}

function responsiveConflict(html: string, css: string, property = 'font-size'): boolean {
  const rules = scanStylesheet(css).rules;
  const conditional = rules.find((rule) => rule.kind === 'conditional');
  if (!conditional) throw new Error('fixture needs a conditional rule');
  const style = conditional.rules.find((rule) => rule.kind === 'style');
  if (!style) throw new Error('fixture needs a responsive style rule');
  const declaration = style.declarations.find((item) => item.property === property);
  if (!declaration) throw new Error(`fixture needs responsive ${property}`);
  return hasUnsafeResponsiveNativeCascade({
    document: new JSDOM(html).window.document,
    rules,
    candidate: { selector: '.candidate', declarationId: declaration.id, property },
  });
}

describe('responsive native cascade guard', () => {
  it('allows a lone source declaration', () => {
    expect(conflict('<p class="candidate">Copy</p>', '.candidate { color: red; }')).toBe(false);
  });

  it('refuses inline styles, including all and font shorthands', () => {
    expect(conflict('<p class="candidate" style="color: blue">Copy</p>', '.candidate { color: red; }')).toBe(true);
    expect(conflict('<p class="candidate" style="all: unset">Copy</p>', '.candidate { color: red; }')).toBe(true);
    expect(conflict('<p class="candidate" style="font: italic 16px serif">Copy</p>', '.candidate { font-size: 20px; }', 'font-size')).toBe(true);
  });

  it('refuses same-element competing selectors and important declarations', () => {
    expect(conflict('<p class="candidate other">Copy</p>', '.candidate { color: red; } .other { color: blue; }')).toBe(true);
    expect(conflict('<p class="candidate">Copy</p>', '.candidate { color: red; } p { color: blue !important; }')).toBe(true);
  });

  it('refuses pseudo-state selectors that target the candidate source element', () => {
    expect(conflict('<p class="candidate">Copy</p>', '.candidate { color: red; } p:hover { color: blue; }')).toBe(true);
    expect(conflict('<p class="candidate">Copy</p>', '.candidate { color: red; } p:unknown-state { color: blue; }')).toBe(true);
  });

  it('permits only an earlier unconditional same-selector base declaration', () => {
    expect(responsiveConflict(
      '<p class="candidate">Copy</p>',
      '.candidate { font-size: 2rem; } @media (width <= 480px) { .candidate { font-size: 1rem; } }',
    )).toBe(false);
    expect(responsiveConflict(
      '<p class="candidate">Copy</p>',
      '@media (width <= 480px) { .candidate { font-size: 1rem; } } .candidate { font-size: 2rem; }',
    )).toBe(true);
  });

  it('recognizes reset shorthands as conflicts', () => {
    expect(responsiveConflict(
      '<p class="candidate">Copy</p>',
      '.candidate { margin: 2rem; } @media (width <= 480px) { .candidate { margin-top: 1rem; } }',
      'margin-top',
    )).toBe(true);
    expect(responsiveConflict(
      '<p class="candidate">Copy</p>',
      '.candidate { font: italic 2rem/1.5 serif; } @media (width <= 480px) { .candidate { line-height: 1.2; } }',
      'line-height',
    )).toBe(true);
  });

  it('keeps a native-looking base declaration scoped when media or state CSS can override it', () => {
    const mediaRules = scanStylesheet('.card { font-size: 32px; } @media (min-width: 600px) { .card { font-size: 16px; } }').rules;
    const mediaBase = (mediaRules[0] as Extract<typeof mediaRules[number], { kind: 'style' }>).declarations[0]!;
    expect(baseStyleDeclarationIdsRequiringScopedCss({
      document: new JSDOM('<p class="card">Copy</p>').window.document,
      rules: mediaRules,
    })).toContain(mediaBase.id);

    const hoverRules = scanStylesheet('.card { font-size: 32px; } .card:hover { font-size: 16px; }').rules;
    const hoverBase = (hoverRules[0] as Extract<typeof hoverRules[number], { kind: 'style' }>).declarations[0]!;
    expect(baseStyleDeclarationIdsRequiringScopedCss({
      document: new JSDOM('<p class="card">Copy</p>').window.document,
      rules: hoverRules,
    })).toContain(hoverBase.id);
  });

  it('does not block a simple unconditional same-selector longhand cascade', () => {
    const rules = scanStylesheet('.card { color: red; } .card { color: blue; }').rules;
    expect(baseStyleDeclarationIdsRequiringScopedCss({
      document: new JSDOM('<p class="card">Copy</p>').window.document,
      rules,
    })).toEqual(new Set());
  });
});
