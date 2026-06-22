import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';

describe('media resolution', () => {
  it('noop keeps URLs and warns when IDs are missing', async () => {
    const report = await convert('<section style="background-image:url(hero.jpg)"><h1>Hello</h1></section>', {
      resolver: 'noop',
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('"url":"hero.jpg"');
    expect(report.items.some((item) => item.reason.includes('noop resolver'))).toBe(true);
  });

  it('map fills image IDs and URLs', async () => {
    const report = await convert('<img src="photo.jpg" alt="Photo">', {
      config: {
        media: {
          resolver: 'map',
          map: {
            'photo.jpg': {
              id: 7,
              url: 'https://example.test/uploads/photo.jpg',
            },
          },
        },
      },
    });

    expect(report.ok).toBe(true);
    expect(report.output).toContain('"id":7');
    expect(report.output).toContain('https://example.test/uploads/photo.jpg');
  });
});
