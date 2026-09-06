import { describe, expect, it } from 'vitest';
import { exactThemePresetTransport, findThemePreset, hashThemeSettings, presetTransport, styleContextFrom, themePresetTokens, unresolvedCssVariables } from '../src/author/style-context.js';

const settings = {
  color: { palette: [{ slug: 'brand', color: '#112233' }] },
  spacing: { spacingSizes: [{ slug: '40', size: '1rem' }] },
  typography: {
    fontSizes: [{ slug: 'large', size: '2rem' }],
    fontFamilies: [{ slug: 'sans', fontFamily: 'Inter, sans-serif' }],
  },
};

describe('author style context', () => {
  it('selects presets by category and normalized exact value, never by a shared slug', () => {
    expect(findThemePreset(settings, 'color', '#112233')).toMatchObject({ slug: 'brand', category: 'color' });
    expect(findThemePreset(settings, 'color', '#112234')).toBeUndefined();
    expect(findThemePreset(settings, 'spacing', '1rem')).toMatchObject({ slug: '40', category: 'spacing' });
    expect(findThemePreset(settings, 'font-size', '2rem')).toMatchObject({ slug: 'large', category: 'font-size' });
    expect(findThemePreset(settings, 'font-family', 'Inter, sans-serif')).toMatchObject({ slug: 'sans', category: 'font-family' });
    expect(themePresetTokens(settings)).toEqual({
      colors: { brand: '#112233' }, spacing: { '40': '1rem' }, fontSizes: { large: '2rem' }, fonts: { sans: 'Inter, sans-serif' },
    });
  });

  it('uses one category-aware native transport for color, typography, and every spacing longhand', () => {
    expect(exactThemePresetTransport(settings, 'color', '#112233')).toMatchObject({ attribute: 'textColor', preset: { slug: 'brand', category: 'color' } });
    expect(exactThemePresetTransport(settings, 'background', '#112233')).toMatchObject({ attribute: 'backgroundColor', preset: { slug: 'brand', category: 'color' } });
    expect(exactThemePresetTransport(settings, 'background-color', '#112233')).toMatchObject({ attribute: 'backgroundColor', preset: { slug: 'brand', category: 'color' } });
    expect(exactThemePresetTransport(settings, 'font-size', '2rem')).toMatchObject({ attribute: 'fontSize', preset: { slug: 'large', category: 'font-size' } });
    expect(exactThemePresetTransport(settings, 'font-family', 'Inter, sans-serif')).toMatchObject({ attribute: 'fontFamily', preset: { slug: 'sans', category: 'font-family' } });
    for (const property of ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']) {
      const transport = exactThemePresetTransport(settings, property, '1rem');
      expect(transport).toMatchObject({ preset: { slug: '40', category: 'spacing' }, value: 'var:preset|spacing|40' });
      expect(transport && 'stylePath' in transport && transport.stylePath).toEqual(['spacing', property.split('-')[0], property.split('-')[1]]);
    }
    expect(presetTransport('font-size', { category: 'color', slug: 'brand', value: '#112233' })).toBeUndefined();
    expect(exactThemePresetTransport(settings, 'font-family', 'Inter')).toBeUndefined();
  });

  it('hashes settings deterministically, independent of object key order', () => {
    expect(hashThemeSettings({ color: settings.color, spacing: settings.spacing }))
      .toBe(hashThemeSettings({ spacing: settings.spacing, color: settings.color }));
    expect(hashThemeSettings({ color: settings.color })).not.toBe(hashThemeSettings({ color: { palette: [] } }));
  });

  it('reports missing WordPress presets and case-sensitive/external variables, but not an unconditional same-rule provider or fallback', () => {
    const css = '.card { --local: red; color: var(--local); background: var(--External); border-color: var(--external, blue); outline: var(--wp--preset--color--brand); fill: var(--wp--preset--color--missing); } .other { --outside: red; } .card { border: var(--outside); } @media (width > 10px) { .card { --conditional: red; } } .card { outline: var(--conditional); } .cycle { --a: var(--b); --b: var(--a); color: var(--a); }';
    expect(unresolvedCssVariables(css, settings)).toEqual(['--External', '--a', '--b', '--conditional', '--outside', '--wp--preset--color--missing']);
  });

  it('keeps the preset inventory, snapshot hash, and variable disclosure on one supplied theme envelope', () => {
    const context = styleContextFrom({ slug: 'example', settings }, '.card { color: var(--wp--preset--color--brand); }');
    expect(context.settingsSha256).toBe(hashThemeSettings(settings));
    expect(context.presets).toContainEqual({ category: 'color', slug: 'brand', value: '#112233' });
    expect(context.unresolvedVariables).toEqual([]);
  });

  it('does not treat fluid or block-specific theme settings as exact native preset evidence', () => {
    const context = styleContextFrom({ settings: {
      ...settings,
      typography: { ...settings.typography, fontSizes: [{ slug: 'fluid', size: '2rem', fluid: true }] },
      blocks: { 'core/heading': { typography: { fontSizes: [] } } },
    } }, '');
    expect(context.presets).not.toContainEqual(expect.objectContaining({ category: 'font-size', slug: 'fluid' }));
    expect(context.limitations).toContain('Fluid font-size presets are not treated as exact literal matches.');
    expect(context.limitations).toContain('Block-specific theme settings are not modelled for native preset matching.');
  });
});
