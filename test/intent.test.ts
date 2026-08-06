import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { realize, validate } from '../src/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('intent assembly', () => {
  it('assembles a nested cover, columns, and buttons tree into valid markup', async () => {
    const report = await realize(
      JSON.stringify({
        blocks: [
          {
            block: 'core/cover',
            children: [
              {
                block: 'core/columns',
                children: [
                  {
                    block: 'core/column',
                    children: [
                      { block: 'core/heading', text: 'Left', level: 2 },
                      {
                        block: 'core/buttons',
                        children: [{ block: 'core/button', text: 'Go', url: '/go' }],
                      },
                    ],
                  },
                  {
                    block: 'core/column',
                    children: [
                      { block: 'core/heading', text: 'Right', level: 2 },
                      {
                        block: 'core/buttons',
                        children: [{ block: 'core/button', text: 'Buy', url: '/buy' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.command).toBe('assemble');
    expect(report.output).toContain('<!-- wp:cover');
    expect(report.output).toContain('<!-- wp:columns -->');
    expect(report.output).toContain('<!-- wp:buttons -->');
    expect((await validate(report.output ?? '')).ok).toBe(true);
  });

  it('fails loudly when intent JSON cannot be parsed', async () => {
    const report = await realize('{not json');

    expect(report.ok).toBe(false);
    expect(report.summary.invalid).toBe(1);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        block: 'input',
        status: 'invalid',
        reason: 'could not parse intent JSON',
      }),
    );
  });

  it('fails loudly when parsed intent contains no blocks', async () => {
    const report = await realize('{"blocks":[]}');

    expect(report.ok).toBe(false);
    expect(report.summary.invalid).toBe(1);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        block: 'input',
        status: 'invalid',
        reason: 'intent parsed but contained no blocks',
      }),
    );
  });

  it('fails loudly when parsed intent contains no assembleable blocks', async () => {
    const report = await realize('{"blocks":[{}]}');

    expect(report.ok).toBe(false);
    expect(report.items[0]?.reason).toBe('intent parsed but contained no blocks');
  });

  it('warns on an unregistered block name without failing the run', async () => {
    const report = await realize('{"blocks":[{"block":"core/not-registered","text":"Hi"}]}');

    expect(report.ok).toBe(true);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        block: 'core/not-registered',
        status: 'warning',
        reason: 'block type is not registered',
        details: { intentPath: 'blocks[0]' },
      }),
    );
  });

  it('resolves media on the intent path', async () => {
    const report = await realize('{"blocks":[{"block":"core/image","url":"photo.jpg","alt":"Photo"}]}', {
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

  it('repairs tokens from resolver options on the intent path', async () => {
    const report = await realize(
      JSON.stringify({
        blocks: [
          {
            block: 'core/group',
            attrs: { style: { color: { background: '#0073aa' } } },
            children: [{ block: 'core/paragraph', text: 'Brand block' }],
          },
        ],
      }),
      {
        tokenResolver: 'file',
        themeJson: path.join(FIXTURES, 'theme.json'),
      },
    );

    expect(report.ok).toBe(true);
    expect(report.output).toContain('"backgroundColor":"primary"');
    expect(report.output).toContain('has-primary-background-color');
    expect(report.output).not.toContain('#0073aa');
  });

  it('warns when a non-default config styling rung does not apply', async () => {
    const report = await realize('{"blocks":[{"block":"core/paragraph","text":"Hi"}]}', {
      config: { styling: 'strict' },
    });

    expect(report.ok).toBe(true);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        block: 'input',
        status: 'warning',
        reason: expect.stringContaining('does not apply to intent trees'),
      }),
    );
  });
});
