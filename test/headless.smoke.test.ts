import { describe, expect, it } from 'vitest';
import { getWp } from '../src/headless/wp.js';

describe('headless Gutenberg boot', () => {
  it('registers core blocks and round-trips nested cover columns buttons markup', async () => {
    const wp = await getWp();

    for (const name of [
      'core/cover',
      'core/columns',
      'core/column',
      'core/buttons',
      'core/button',
      'core/image',
      'core/heading',
    ]) {
      expect(wp.getBlockType(name)).toBeTruthy();
    }

    const tree = wp.createBlock(
      'core/cover',
      {
        url: 'https://example.test/hero.jpg',
        id: 123,
        dimRatio: 0,
        tagName: 'section',
        align: 'full',
      },
      [
        wp.createBlock('core/columns', { isStackedOnMobile: true }, [
          wp.createBlock('core/column', {}, [
            wp.createBlock('core/heading', { level: 2, content: 'Left' }, []),
            wp.createBlock('core/buttons', {}, [
              wp.createBlock('core/button', { url: '#', text: 'Go' }, []),
            ]),
          ]),
          wp.createBlock('core/column', {}, [
            wp.createBlock(
              'core/image',
              {
                id: 321,
                url: 'https://example.test/image.jpg',
                alt: '',
              },
              [],
            ),
          ]),
        ]),
      ],
    );

    const markup = wp.serialize([tree]);
    const parsed = wp.parse(markup);
    expect(wp.serialize(parsed)).toBe(markup);
    expect(parsed[0]?.name).toBe('core/cover');
    expect(wp.validateBlock(parsed[0]!)[0]).toBe(true);
  });
});
