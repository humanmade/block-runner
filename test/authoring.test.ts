import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileAuthoringPlan } from '../src/index.js';
import type { AuthoringPlan, InnerBlocksLock } from '../src/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'authoring');

function representativePlan(templateLock: InnerBlocksLock = false): AuthoringPlan {
  return {
    name: 'acme/editorial-hero',
    title: 'Editorial hero',
    description: 'A wrapper with only native editable content.',
    templateLock,
    root: {
      path: 'hero',
      role: 'wrapper',
      children: [
        { path: 'hero.title', role: 'heading', content: 'A native heading', level: 1 },
        { path: 'hero.summary', role: 'paragraph', content: 'A native paragraph.' },
        {
          path: 'hero.image',
          role: 'image',
          url: 'https://example.test/hero.jpg',
          alt: 'Editorial hero',
        },
        {
          path: 'hero.points',
          role: 'list',
          attributes: { ordered: true },
          children: [
            { path: 'hero.points.first', role: 'list-item', content: 'First point' },
            { path: 'hero.points.second', role: 'list-item', content: 'Second point' },
          ],
        },
        {
          path: 'hero.actions',
          role: 'buttons',
          children: [
            { path: 'hero.actions.primary', role: 'button', content: 'Start', url: '/start' },
          ],
        },
      ],
    },
  };
}

describe('registered block authoring compiler', () => {
  it('keeps representative editable content in one native InnerBlocks template', () => {
    const compiled = compileAuthoringPlan(representativePlan('all'));
    const metadata = JSON.parse(compiled.files['block.json']!);

    expect(compiled.template).toEqual([
      ['core/heading', { content: 'A native heading', level: 1 }],
      ['core/paragraph', { content: 'A native paragraph.' }],
      ['core/image', { url: 'https://example.test/hero.jpg', alt: 'Editorial hero' }],
      [
        'core/list',
        { ordered: true },
        [
          ['core/list-item', { content: 'First point' }],
          ['core/list-item', { content: 'Second point' }],
        ],
      ],
      ['core/buttons', {}, [['core/button', { text: 'Start', url: '/start' }]]],
    ]);

    expect(metadata).toMatchObject({
      apiVersion: 3,
      name: 'acme/editorial-hero',
      allowedBlocks: ['core/heading', 'core/paragraph', 'core/image', 'core/list', 'core/buttons'],
      supports: { html: false },
    });
    expect(metadata.attributes).toBeUndefined();
    expect(metadata.supports.allowedBlocks).toBeUndefined();
    expect(compiled.files['block.json']).not.toContain('A native heading');

    expect(compiled.files['edit.js']).toContain('const blockProps = useBlockProps();');
    expect(compiled.files['edit.js']).toContain('useInnerBlocksProps( blockProps, {');
    expect(compiled.files['edit.js']).toContain('allowedBlocks: ALLOWED_BLOCKS');
    expect(compiled.files['edit.js']).toContain('templateLock: TEMPLATE_LOCK');
    expect(compiled.files['edit.js']).toContain('return <div { ...innerBlocksProps } />;');
    expect(compiled.files['save.js']).toContain('const blockProps = useBlockProps.save();');
    expect(compiled.files['save.js']).toContain('useInnerBlocksProps.save( blockProps )');
    expect(compiled.files['save.js']).toContain('return <div { ...innerBlocksProps } />;');

    expect(compiled.editableFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'hero.title', block: 'core/heading', attribute: 'content', surface: 'richText' }),
        expect.objectContaining({ path: 'hero.summary', block: 'core/paragraph', attribute: 'content', surface: 'richText' }),
        expect.objectContaining({ path: 'hero.image', block: 'core/image', attribute: 'url', surface: 'media' }),
        expect.objectContaining({ path: 'hero.points.first', block: 'core/list-item', attribute: 'content', surface: 'richText' }),
        expect.objectContaining({ path: 'hero.actions.primary', block: 'core/button', attribute: 'text', surface: 'richText' }),
        expect.objectContaining({ path: 'hero.actions.primary', block: 'core/button', attribute: 'url', surface: 'link' }),
      ]),
    );
  });

  it('gives a quote its own stable paragraph child instead of the retired value surface', () => {
    const plan = representativePlan();
    plan.root.children!.push({
      path: 'hero.quote',
      role: 'quote',
      content: 'Native quote text.',
    });

    const compiled = compileAuthoringPlan(plan);

    expect(compiled.template.at(-1)).toEqual([
      'core/quote',
      {},
      [['core/paragraph', { content: 'Native quote text.' }]],
    ]);
    expect(compiled.editableFields).toContainEqual({
      path: 'hero.quote.content',
      role: 'paragraph',
      block: 'core/paragraph',
      attribute: 'content',
      surface: 'richText',
    });
    expect(compiled.editableFields).not.toContainEqual(
      expect.objectContaining({ path: 'hero.quote', block: 'core/quote' }),
    );
  });

  for (const templateLock of [false, 'insert', 'all', 'contentOnly'] as const satisfies readonly InnerBlocksLock[]) {
    it(`emits the confirmed ${String(templateLock)} locking mode without changing the child template`, () => {
      const compiled = compileAuthoringPlan(representativePlan(templateLock));
      expect(compiled.templateLock).toBe(templateLock);
      expect(compiled.files['template.js']).toContain(`export const TEMPLATE_LOCK = ${JSON.stringify(templateLock)};`);
      expect(compiled.files['edit.js']).toContain('templateLock: TEMPLATE_LOCK');
    });
  }

  it('documents the WordPress 7.1 contentOnly limitation without treating it as invalid markup', async () => {
    const fixture = JSON.parse(await readFile(path.join(FIXTURES, 'content-only.plan.json'), 'utf8')) as AuthoringPlan;
    const compiled = compileAuthoringPlan(fixture);

    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warning', code: 'gutenberg-76794' }),
    );
    expect(compiled.files['README.md']).toContain('Gutenberg #76794');
    expect(compiled.files['README.md']).toContain('runtime fixture renders the Inspector');
    expect(compiled.files['README.md']).toContain('not invalid block markup or a recovery state');
    expect(JSON.parse(compiled.files['block.json']!).attributes).toBeUndefined();
  });

  it('warns instead of silently creating a second wrapper InnerBlocks region', () => {
    const plan = representativePlan();
    plan.root.children!.push({
      path: 'hero.carousel',
      role: 'custom',
      block: 'acme/carousel-slide',
      requiresOwnInnerBlocks: true,
    });

    const compiled = compileAuthoringPlan(plan);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        code: 'custom-child-justification-required',
        path: 'hero.carousel',
      }),
    );
  });
});
