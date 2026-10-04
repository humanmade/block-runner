import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { assemble, realize, validate } from '../../src/index.js';
import { getWp } from '../../src/headless/wp.js';
import * as media from '../../src/media/resolver.js';
import type { IntentNode } from '../../src/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('intent assembly', () => {
  it('preserves the native styles and headerless table taught in the shipped guide', async () => {
    const guide = await readFile(new URL('../../skills/block-runner/references/ASSEMBLE.md', import.meta.url), 'utf8');
    const example = guide.match(/### Native styles and layout[\s\S]*?```json\n([\s\S]*?)\n```/);
    expect(example).not.toBeNull();
    const report = await realize(example![1]);
    expect(report.ok).toBe(true);
    expect(report.summary.warnings).toBe(0);
    const wp = await getWp();
    const [group] = wp.parse(report.output!);
    expect(group.attributes.layout).toEqual({ type: 'constrained' });
    const [paragraph, table] = group.innerBlocks;
    expect(paragraph.attributes).toMatchObject({
      textColor: 'contrast', backgroundColor: 'base', className: 'is-style-callout',
      style: {
        typography: { textAlign: 'center' },
        spacing: { padding: { top: 'var:preset|spacing|40', bottom: 'var:preset|spacing|40' } },
      },
    });
    expect(table.attributes.head).toEqual([]);
    expect(report.output).not.toContain('<thead>');
    expect(report.output).toContain('<td>Name</td><td>Value</td>');
  });

  it.each([false, true])('warns for discarded explicit attributes without failing (strict: %s)', async (strict) => {
    const report = await realize(JSON.stringify({ blocks: [{
      block: 'core/group', children: [{
        block: 'core/paragraph', text: 'Example', attrs: { textAlign: 'center', madeUp: 'private-value' },
      }],
    }] }), { strict, sourcePath: 'intent.json' });
    expect(report.ok).toBe(true);
    expect(report.summary.warnings).toBe(2);
    expect(report.output).toContain('<p>Example</p>');
    for (const key of ['textAlign', 'madeUp']) {
      expect(report.items).toContainEqual(expect.objectContaining({
        code: 'intent-attribute-dropped', block: 'core/paragraph', status: 'warning',
        source: { path: 'intent.json' },
        details: { intentPath: `blocks[0].children[0].attrs[${JSON.stringify(key)}]`, attribute: key },
      }));
    }
    expect(JSON.stringify(report.items)).not.toContain('private-value');
  });

  it('keeps discarded attributes informational even when keys contain strict-warning text', async () => {
    const report = await realize(JSON.stringify({ blocks: [{
      block: 'core/paragraph', text: 'Example', attrs: { 'no ID': true, 'Custom HTML fallback': true },
    }] }), { strict: true });
    expect(report.ok).toBe(true);
    expect(report.summary.warnings).toBe(2);
    expect(report.items.every((item) => item.code === 'intent-attribute-dropped')).toBe(true);
  });

  it('does not confuse accepted native attributes or normalization with discarded keys', async () => {
    const report = await realize(JSON.stringify({ blocks: [{
      block: 'core/group', attrs: { layout: { type: 'constrained' } }, children: [{
        block: 'core/paragraph', text: 'Shorthand wins', attrs: {
          content: '<strong>Attribute content</strong>', dropCap: false,
          style: { typography: { textAlign: 'center' }, custom: { untouched: true } },
          metadata: { name: 'Text', bindings: { content: { source: 'core/post-meta', args: { key: 'summary' } } } },
        },
      }, {
        block: 'core/paragraph', attrs: { content: '<strong>Rich text</strong>' },
      }],
    }] }));
    expect(report.ok).toBe(true);
    expect(report.summary.warnings).toBe(0);
    expect(report.output).toContain('Shorthand wins');
    expect(report.output).not.toContain('Attribute content');
    expect(report.output).toContain('<strong>Rich text</strong>');
    const wp = await getWp();
    const paragraph = wp.parse(report.output!)[0].innerBlocks[0];
    expect(paragraph.attributes.style).toMatchObject({ typography: { textAlign: 'center' }, custom: { untouched: true } });
    expect(paragraph.attributes.metadata).toMatchObject({ name: 'Text', bindings: { content: { source: 'core/post-meta' } } });
    expect(await assemble([{ block: 'core/paragraph', text: 'Still an array', attrs: { madeUp: true } }])).toHaveLength(1);
  });

  it.each([false, true])('preserves nested lists and siblings (ordered: %s)', async (ordered) => {
    const report = await realize(JSON.stringify({ blocks: [{
      block: 'core/list', attrs: { ordered }, children: [
        { block: 'core/list-item', text: 'Parent', children: [{
          block: 'core/list', attrs: { ordered: !ordered }, children: [
            { block: 'core/list-item', text: 'Child', children: [{
              block: 'core/list', items: ['Grandchild'],
            }] },
            { block: 'core/list-item', text: 'Child sibling' },
          ],
        }] },
        { block: 'core/list-item', text: 'Parent sibling' },
      ],
    }] }));
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ blocks: 8, valid: 8, invalid: 0 });
    const wp = await getWp();
    const [list] = wp.parse(report.output!);
    expect(list.attributes.ordered).toBe(ordered);
    expect(list.innerBlocks.map((item) => String(item.attributes.content))).toEqual(['Parent', 'Parent sibling']);
    const childList = list.innerBlocks[0].innerBlocks[0];
    expect(childList.attributes.ordered).toBe(!ordered);
    expect(childList.innerBlocks.map((item) => String(item.attributes.content))).toEqual(['Child', 'Child sibling']);
    expect(String(childList.innerBlocks[0].innerBlocks[0].innerBlocks[0].attributes.content)).toBe('Grandchild');
    expect((await validate(wp.serialize(wp.parse(report.output!)))).ok).toBe(true);
  });

  it('preserves plain list shorthand', async () => {
    const report = await realize('{"block":"core/list","items":["First","Second"]}');
    const wp = await getWp();
    expect(report.ok).toBe(true);
    expect(wp.parse(report.output!)[0].innerBlocks.map((item) => String(item.attributes.content))).toEqual(['First', 'Second']);
  });

  it('rejects nested synced-pattern children before serialization loses them', async () => {
    const report = await realize(JSON.stringify({ blocks: [{
      block: 'core/group', children: [{
        block: 'core/block', attrs: { ref: 123 },
        children: [{ block: 'core/paragraph', text: 'Keep this content' }],
      }],
    }] }), { sourcePath: 'intent.json' });
    expect(report.ok).toBe(false);
    expect(report.output).toBe('');
    expect(report.items).toContainEqual(expect.objectContaining({
      block: 'core/block', status: 'invalid', source: { path: 'intent.json' },
      details: { blockPath: 'blocks[0].innerBlocks[0]', locationKind: 'block-tree' },
    }));
  });

  it('preserves synced-pattern overrides supplied as attributes', async () => {
    const report = await realize(JSON.stringify({ blocks: [{
      block: 'core/block', attrs: { ref: 123, content: { Text: { content: 'Custom text' } } },
    }] }));
    expect(report.ok).toBe(true);
    expect(report.output).toBe('<!-- wp:block {"ref":123,"content":{"Text":{"content":"Custom text"}}} /-->');
  });

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
    expect(report.items[0]?.reason).toContain('blocks[0]: expected a node with a non-empty block name');
  });

  it.each([
    [[{ block: 'core/paragraph', text: 'First' }, { text: 'Second' }], 'blocks[1]'],
    [[{ block: 'core/group', children: [null] }], 'blocks[0].children[0]'],
    [[{ block: 'core/group', children: {} }], 'blocks[0].children'],
    [[{ block: 'core/group', children: null }], 'blocks[0].children'],
    [[{ block: '' }], 'blocks[0]'],
    [[{ block: 'core/list', items: ['First', { text: 'Second' }] }], 'blocks[0].items[1]'],
    [[{ block: 'core/list', items: 'First' }], 'blocks[0].items'],
    [[{ block: 'core/table', rows: [['First'], [{ text: 'Second' }]] }], 'blocks[0].rows[1][0]'],
    [[{ block: 'core/table', rows: ['First'] }], 'blocks[0].rows[0]'],
    [[{ block: 'core/table', rows: {} }], 'blocks[0].rows'],
  ])('rejects malformed consumed input %j at %s', async (nodes, location) => {
    const report = await realize(JSON.stringify({ blocks: nodes }), { sourcePath: 'intent.json' });
    expect(report.ok).toBe(false);
    expect(report.output).toBe('');
    expect(report.items[0]).toMatchObject({ status: 'invalid', source: { path: 'intent.json' } });
    expect(report.items[0].reason).toContain(`${location}: expected`);
    await expect(assemble(nodes as IntentNode[])).rejects.toThrow(`${location}: expected`);
  });

  it('rejects malformed input before constructing the media resolver', async () => {
    const resolver = vi.spyOn(media, 'createMediaResolver');
    try {
      const report = await realize(JSON.stringify({ blocks: [
        { block: 'core/image', url: 'photo.jpg' }, { text: 'Missing name' },
      ] }));
      expect(report.ok).toBe(false);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      resolver.mockRestore();
    }
  });

  it.each([
    '{"block":"core/paragraph","text":"Text"}',
    '[{"block":"core/paragraph","text":"Text"}]',
    '{"blocks":[{"block":"core/paragraph","text":"Text"}]}',
    '```json\n{"blocks":[{"block":"core/paragraph","text":"Text"}]}\n```',
  ])('keeps valid input wrappers', async (raw) => {
    expect((await realize(raw)).ok).toBe(true);
  });

  it('keeps explicit tables and ignores unused list shorthand', async () => {
    const report = await realize(JSON.stringify({ blocks: [
      { block: 'core/list', items: { unused: true }, children: [{ block: 'core/list-item', text: 'Kept' }] },
      { block: 'core/table', attrs: { body: [{ cells: [{ content: 'Body only', tag: 'td' }] }] } },
      { block: 'core/table', rows: [['Header'], ['Cell']] },
    ] }));
    expect(report.ok).toBe(true);
    expect(report.output).toContain('Kept');
    expect(report.output).toContain('<td>Body only</td>');
    expect(report.output).toContain('<th>Header</th>');
    expect(report.output).toContain('<td>Cell</td>');
  });

  it.each([false, true])('rejects unregistered blocks without partial output (strict: %s)', async (strict) => {
    const unknown = { block: 'example/unregistered', children: [{ block: 'core/paragraph', text: 'Keep me' }] };
    for (const [nodes, location] of [
      [[unknown], 'blocks[0]'],
      [[{ block: 'core/image', url: 'photo.jpg' }, { block: 'core/group', children: [unknown] }], 'blocks[1].children[0]'],
    ] as const) {
      const resolver = vi.spyOn(media, 'createMediaResolver');
      try {
        const report = await realize(JSON.stringify({ blocks: nodes }), { strict, sourcePath: 'intent.json' });
        expect(report.ok).toBe(false);
        expect(report.output).toBe('');
        expect(report.items[0]).toMatchObject({ status: 'invalid', source: { path: 'intent.json' } });
        expect(report.items[0].reason).toContain(`${location}: block type`);
        expect(report.items[0].reason).toContain('example/unregistered');
        expect(resolver).not.toHaveBeenCalled();
        await expect(assemble([...nodes] as IntentNode[])).rejects.toThrow('is not registered');
      } finally {
        resolver.mockRestore();
      }
    }
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

  it('preserves an explicitly supplied heading anchor without inferring one', async () => {
    const report = await realize('{"blocks":[{"block":"core/heading","text":"Details","attrs":{"anchor":"details"}}]}');

    expect(report.ok).toBe(true);
    expect(report.output).toContain('"anchor":"details"');
    expect(report.output).toContain('id="details"');
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
