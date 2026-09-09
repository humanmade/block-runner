import { describe, expect, it } from 'vitest';
import { author } from '../../src/author/index.js';
import { validateCoverageFulfillment } from '../../src/author/plan.js';
import { hashAuthoringPlan } from '../../src/authoring/schema.js';
import type { AuthorOptions } from '../../src/types.js';

const markup = '<p class="notice">Keep this text</p>';
const settings = { color: { palette: [{ slug: 'brand', color: '#112233' }] } };

function options(color = '#112233'): AuthorOptions {
  return { author: { name: 'example/style-roundtrip', styles: {
    mode: 'css', css: `.notice { color: ${color}; }`, context: { theme: { settings: structuredClone(settings) } },
  } } };
}

describe('target style decisions survive the public authoring workflow', () => {
  it('returns a preset-owned plan that can be validated and submitted unchanged', async () => {
    const input = options();
    const result = await author(markup, input);
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    const plan = result.package!.canonicalPlan!;
    expect(plan.structure[0]!.attributes).toMatchObject({ textColor: 'brand' });
    expect(plan.coverage!.styles).toContainEqual(expect.objectContaining({ property: 'color', value: '#112233', outcome: 'preset' }));
    expect(() => validateCoverageFulfillment(plan)).not.toThrow();
    const changedPreset = structuredClone(plan);
    changedPreset.structure[0]!.attributes!.textColor = 'unrelated';
    expect(() => validateCoverageFulfillment(changedPreset)).toThrow();
    changedPreset.styles.outcomes = [{ property: 'color', value: '#112233', outcome: 'token' }];
    expect(() => validateCoverageFulfillment(changedPreset)).toThrow();
    const repeated = await author(markup, { ...input, plan });
    expect(repeated.ok, JSON.stringify(repeated.items)).toBe(true);
    expect(repeated.package!.files).toEqual(result.package!.files);
  });

  it('returns a native responsive plan that can be submitted unchanged', async () => {
    const input: AuthorOptions = { author: { name: 'example/style-roundtrip', styles: {
      mode: 'css', css: '.card { font-size: 32px; } @media (width <= 480px) { .card { font-size: 16px; } }',
      context: { theme: { settings: { viewport: { mobile: '480px', tablet: '782px' } } } },
    } } };
    const source = '<h2 class="card">Keep this text</h2>';
    const result = await author(source, input);
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    const plan = result.package!.canonicalPlan!;
    expect(plan.structure[0]!.attributes).toMatchObject({ style: { '@mobile': { typography: { fontSize: '16px' } } } });
    expect(() => validateCoverageFulfillment(plan)).not.toThrow();
    const repeated = await author(source, { ...input, plan });
    expect(repeated.ok, JSON.stringify(repeated.items)).toBe(true);
    expect(repeated.package!.files).toEqual(result.package!.files);
  });

  it.each([
    ['font-size', '2rem', { typography: { fontSizes: [{ slug: 'large', size: '2rem' }] } }],
    ['font-family', 'Georgia, serif', { typography: { fontFamilies: [{ slug: 'serif', fontFamily: 'Georgia, serif' }] } }],
    ['margin-top', '1rem', { spacing: { spacingSizes: [{ slug: '40', size: '1rem' }] } }],
  ])('round-trips a matching %s preset, not only colors', async (property, value, targetSettings) => {
    const input: AuthorOptions = { author: { name: 'example/style-roundtrip', styles: {
      mode: 'css', css: `.notice { ${property}: ${value}; }`, context: { theme: { settings: targetSettings } },
    } } };
    const result = await author(markup, input);
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    const plan = result.package!.canonicalPlan!;
    expect(plan.coverage!.styles).toContainEqual(expect.objectContaining({ property, value, outcome: 'preset' }));
    expect(() => validateCoverageFulfillment(plan)).not.toThrow();
    const repeated = await author(markup, { ...input, plan });
    expect(repeated.ok, JSON.stringify(repeated.items)).toBe(true);
    expect(repeated.package!.files).toEqual(result.package!.files);
  });

  it('never uses stale configured presets or approximate colors against an explicit target', async () => {
    const input = options('#112234');
    input.config = { tokens: { colors: { stale: '#112234' }, match: 'nearest' } };
    const result = await author(markup, input);
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    expect(result.package!.canonicalPlan!.structure[0]!.attributes).toMatchObject({ style: { color: { text: '#112234' } } });
    expect(result.package!.canonicalPlan!.structure[0]!.attributes?.textColor).toBeUndefined();
    expect(result.package!.canonicalPlan!.coverage!.styles.every((entry) => entry.outcome !== 'preset')).toBe(true);
  });

  it('does not mutate the target and invalidates a reviewed plan when its preset value changes', async () => {
    const input = options();
    const before = structuredClone(input);
    const first = await author(markup, input);
    expect(first.ok, JSON.stringify(first.items)).toBe(true);
    expect(input).toEqual(before);
    const changed = options();
    changed.author!.styles!.context!.theme!.settings = { color: { palette: [{ slug: 'brand', color: '#445566' }] } };
    const second = await author(markup, changed);
    expect(second.ok, JSON.stringify(second.items)).toBe(true);
    expect(hashAuthoringPlan(first.package!.canonicalPlan!)).not.toBe(hashAuthoringPlan(second.package!.canonicalPlan!));
    const stale = await author(markup, { ...changed, plan: first.package!.canonicalPlan! });
    expect(stale.ok).toBe(false);
    expect(stale.package).toBeUndefined();
  });

  it.each([
    ['<p class="card" style="font-size:20px">Keep this text</p>', '@media (width <= 480px) { .card { font-size:12px; } }'],
    ['<p class="card other">Keep this text</p>', '.other { font-size:20px!important; } @media (width <= 480px) { .card { font-size:12px; } }'],
    ['<p class="card">Keep this text</p>', 'p.card { font:20px sans-serif!important; } @media (width <= 480px) { .card { font-size:12px; } }'],
  ])('keeps responsive source CSS when native priority would change the cascade: %s', async (source, css) => {
    const result = await author(source, { author: { name: 'example/style-roundtrip', styles: {
      mode: 'css', css, context: { theme: { settings: { viewport: { mobile: '480px', tablet: '782px' } } } },
    } } });
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    const style = result.package!.canonicalPlan!.structure[0]!.attributes?.style as Record<string, unknown> | undefined;
    expect(style?.['@mobile']).toBeUndefined();
    expect(result.package!.files['style.scss']).toContain('@media (width <= 480px)');
    expect(result.package!.canonicalPlan!.coverage!.styles).toContainEqual(expect.objectContaining({
      property: 'font-size', value: '12px', outcome: 'scoped-css', atRules: ['@media (width <= 480px)'],
    }));
  });

  it.each([
    '@media (min-width: 600px) { .card { font-size: 16px; } }',
    '.card:hover { font-size: 16px; }',
  ])('keeps base CSS out of inline attributes when it would defeat the residual rule: %s', async (conditional) => {
    const result = await author('<h2 class="card">Keep this text</h2>', { author: {
      name: 'example/style-roundtrip', styles: { mode: 'css', css: `.card { font-size: 32px; } ${conditional}` },
    } });
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    const style = result.package!.canonicalPlan!.structure[0]!.attributes?.style as { typography?: { fontSize?: string } } | undefined;
    expect(style?.typography?.fontSize).toBeUndefined();
    expect(result.package!.canonicalPlan!.coverage!.styles.filter((entry) => entry.property === 'font-size'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ value: '32px', outcome: 'scoped-css' }),
        expect.objectContaining({ value: '16px', outcome: 'scoped-css' }),
      ]));
  });

  it('preserves the responsive cascade for repeated source classes too', async () => {
    const source = '<h2 class="card">First</h2><h2 class="card">Second</h2>';
    const result = await author(source, { author: { name: 'example/style-roundtrip', styles: {
      mode: 'css', css: '.card { font-size:32px; } @media (min-width:600px) { .card { font-size:16px; } }',
    } } });
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    expect(result.package!.canonicalPlan!.structure).toHaveLength(2);
    for (const node of result.package!.canonicalPlan!.structure) {
      const style = node.attributes?.style as { typography?: { fontSize?: string } } | undefined;
      expect(style?.typography?.fontSize).toBeUndefined();
    }
    expect(result.package!.canonicalPlan!.coverage!.styles.filter((entry) => entry.property === 'font-size'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ value: '32px', outcome: 'scoped-css' }),
        expect.objectContaining({ value: '16px', outcome: 'scoped-css' }),
      ]));
  });
});
