import { describe, expect, it } from 'vitest';
import { mapExactWordPressResponsiveMedia, resolveWordPressViewportRanges } from '../src/author/responsive.js';

describe('WordPress 7.1 responsive viewport contract', () => {
  it('reproduces WordPress defaults and configured viewport sanitization', () => {
    expect(resolveWordPressViewportRanges()).toEqual({
      mobile: { max: '480px' },
      tablet: { min: '480px', max: '782px' },
    });
    expect(resolveWordPressViewportRanges({ mobile: '30rem', tablet: '45rem' })).toEqual({
      mobile: { max: '30rem' },
      tablet: { min: '30rem', max: '45rem' },
    });
    expect(resolveWordPressViewportRanges({ mobile: '500px', tablet: '500px' })).toEqual({ mobile: { max: '500px' } });
    expect(resolveWordPressViewportRanges({ mobile: 'invalid', tablet: '45rem' })).toEqual({ tablet: { max: '45rem' } });
    expect(resolveWordPressViewportRanges({ mobile: '50%', tablet: 'calc(50px)' })).toEqual({
      mobile: { max: '480px' },
      tablet: { min: '480px', max: '782px' },
    });
  });

  it('maps only canonical WordPress mobile/tablet intervals', () => {
    const settings = { mobile: '30rem', tablet: '45rem' };
    expect(mapExactWordPressResponsiveMedia('(width <= 30rem)', settings)).toBe('mobile');
    expect(mapExactWordPressResponsiveMedia('(max-width: 30rem)', settings)).toBe('mobile');
    expect(mapExactWordPressResponsiveMedia('(30rem < width <= 45rem)', settings)).toBe('tablet');
  });

  it('does not approximate inclusive, desktop, cross-unit, compound, or non-media conditions', () => {
    const settings = { mobile: '480px', tablet: '782px' };
    expect(mapExactWordPressResponsiveMedia('(min-width: 783px)', settings)).toBeUndefined();
    expect(mapExactWordPressResponsiveMedia('(min-width: 480px) and (max-width: 782px)', settings)).toBeUndefined();
    expect(mapExactWordPressResponsiveMedia('(width <= 480px) and (prefers-reduced-motion: reduce)', settings)).toBeUndefined();
    expect(mapExactWordPressResponsiveMedia('(480px < width <= 781px)', settings)).toBeUndefined();
    expect(mapExactWordPressResponsiveMedia('(width <= 30rem)', settings)).toBeUndefined();
    expect(mapExactWordPressResponsiveMedia('@container (width <= 480px)', settings)).toBeUndefined();
  });
});
