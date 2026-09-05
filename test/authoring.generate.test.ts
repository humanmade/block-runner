import { describe, expect, it } from 'vitest';
import {
  AuthoringGenerationError,
  compileRegisteredBlock,
  REGISTERED_BLOCK_STYLE_EMITTER_VERSION,
  REGISTERED_BLOCK_TEMPLATE_VERSION,
  type GeneratedSourceFile,
  validateBlockMetadata,
} from '../src/authoring/generate.js';
import { hashAuthoringPlan, type AuthoringPlan } from '../src/authoring/schema.js';

const plan = (): AuthoringPlan =>
  ({
    version: 1,
    generatorVersion: '0.9.0',
    target: {
      name: 'acme/callout',
      title: 'Callout',
    },
    structure: [
      {
        block: 'core/group',
        attributes: { tagName: 'aside' },
        children: [
          {
            block: 'core/heading',
            attributes: { level: 2, content: 'Plan once, ship safely' },
          },
          {
            block: 'core/paragraph',
            attributes: { content: 'This is native inner block content.' },
          },
        ],
      },
    ],
    fields: [],
    locking: { mode: 'contentOnly' },
    styles: {
      strategy: 'mixed',
      outcomes: [
        { property: 'border', outcome: 'scoped-css', value: '1px solid #111' },
        { property: 'color', outcome: 'token', token: 'primary' },
      ],
    },
    pattern: { ready: false, overrides: [] },
    assets: [],
    files: [],
    warnings: [],
  }) as AuthoringPlan;

function sourceFile(files: GeneratedSourceFile[], path: string): GeneratedSourceFile {
  const found = files.find((file) => file.path === path);
  expect(found, `expected generated source file ${path}`).toBeDefined();
  return found!;
}

/** Converts either a synchronous compiler failure or a future async implementation into a promise. */
function compileFailure(input: AuthoringPlan): Promise<unknown> {
  return Promise.resolve().then(() => compileRegisteredBlock(input));
}

describe('registered-block source compiler', () => {
  it('emits a byte-identical, self-contained static package for the same confirmed plan', async () => {
    const first = await compileRegisteredBlock(plan());
    const second = await compileRegisteredBlock(plan());

    expect(first).toEqual(second);
    expect(first.templateVersion).toBe(REGISTERED_BLOCK_TEMPLATE_VERSION);
    expect(first.templateVersion).toBe(second.templateVersion);
    expect(first.sourcePlanHash).toBe(hashAuthoringPlan(plan()));
    expect(first.manifest.sourcePlanHash).toBe(first.sourcePlanHash);
    expect(first.manifest.templateVersion).toBe(first.templateVersion);
    expect(first.files.map((file) => file.path)).toEqual([
      'block.json',
      'index.js',
      'edit.js',
      'save.js',
      'style.scss',
      'editor.scss',
      'block.php',
    ]);

    for (const file of first.files) {
      expect(file.kind).toMatch(/^(json|javascript|scss|php)$/);
      expect(file.content).not.toHaveLength(0);
      expect(file.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.manifest.files).toContainEqual({
        path: file.path,
        kind: file.kind,
        contentHash: file.hash,
        operation: file.operation,
        templateVersion: first.templateVersion,
        sourcePlanHash: first.sourcePlanHash,
      });
    }

    const metadata = JSON.parse(sourceFile(first.files, 'block.json').content) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      apiVersion: 3,
      name: 'acme/callout',
      title: 'Callout',
      editorScript: 'file:./index.js',
      style: 'file:./style-index.css',
      editorStyle: 'file:./index.css',
    });
    expect(metadata).not.toHaveProperty('viewScript');
    expect(metadata).not.toHaveProperty('render');

    const index = sourceFile(first.files, 'index.js').content;
    expect(index).toContain('registerBlockType');
    expect(index).toContain('metadata');

    const edit = sourceFile(first.files, 'edit.js').content;
    expect(edit).toContain('core/heading');
    expect(edit).toContain('Plan once, ship safely');
    expect(edit).toContain('core/paragraph');
    expect(edit).toContain('This is native inner block content.');
    expect(edit).toContain('useInnerBlocksProps( blockProps');
    expect(edit).toContain('<div { ...innerBlocksProps } />');
    expect(edit).not.toContain('<InnerBlocks');

    const save = sourceFile(first.files, 'save.js').content;
    expect(save).toContain('useInnerBlocksProps.save( blockProps )');
    expect(save).toContain('<div { ...innerBlocksProps } />');
    expect(save).not.toContain('InnerBlocks.Content');

    const php = sourceFile(first.files, 'block.php').content;
    expect(php).toContain('register_block_type');
    expect(php).toContain('__DIR__');

    const style = sourceFile(first.files, 'style.scss').content;
    expect(style).toContain(`style emitter v${REGISTERED_BLOCK_STYLE_EMITTER_VERSION}`);
    expect(style).toContain('border: 1px solid #111;');
    expect(style).toContain('color: var(--wp--preset--color--primary);');
    expect(sourceFile(first.files, 'editor.scss').content).not.toContain('border: 1px solid #111;');

    for (const file of first.files) {
      expect(file.content).not.toMatch(/block[- ]runner|tailwind/i);
    }
  });

  it('uses the full pinned WordPress schema, including support-value constraints', () => {
    expect(() => validateBlockMetadata({
      apiVersion: 3,
      name: 'acme/invalid-support',
      title: 'Invalid support',
      supports: { align: ['narrow'] },
    })).toThrow(/metadata-schema-invalid/);
  });

  it('rejects event-bearing rich text deeply nested in a table-cell attribute with a source path', async () => {
    const unsafe = plan();
    unsafe.structure = [
      {
        block: 'core/table',
        attributes: {
          body: [
            {
              cells: [{ tag: 'td', content: '<img src="x" onerror="alert(1)">' }],
            },
          ],
        },
      },
    ];

    await expect(compileFailure(unsafe)).rejects.toBeInstanceOf(AuthoringGenerationError);
    await expect(compileFailure(unsafe)).rejects.toMatchObject({
      reason: expect.stringContaining('unsafe-inner-content'),
      source: expect.objectContaining({ path: expect.stringContaining('cells[0].content') }),
    });
  });

  it('rejects unsafe URL schemes in gallery image objects with a source path', async () => {
    const unsafe = plan();
    unsafe.structure = [
      {
        block: 'core/gallery',
        attributes: {
          images: [{ id: 7, url: 'java\nscript:alert(1)', alt: 'Unsafe image' }],
        },
      },
    ];

    await expect(compileFailure(unsafe)).rejects.toBeInstanceOf(AuthoringGenerationError);
    await expect(compileFailure(unsafe)).rejects.toMatchObject({
      reason: expect.stringContaining('unsafe-inner-content'),
      source: expect.objectContaining({ path: expect.stringContaining('images[0].url') }),
    });
  });

  it('rejects raw stylesheet fields and CSS fragments outside the versioned style emitter', async () => {
    const rawCss = plan() as AuthoringPlan & { styles: AuthoringPlan['styles'] & { css?: string; editorCss?: string } };
    rawCss.styles.css = '.wp-block-acme-callout + .wp-block-group { color: red; }';

    await expect(compileFailure(rawCss)).rejects.toThrow(/styles\.css is not part of AuthoringPlan v1/);

    const rawEditorCss = plan() as AuthoringPlan & { styles: AuthoringPlan['styles'] & { editorCss?: string } };
    rawEditorCss.styles.editorCss = '@layer utilities { .wp-block-acme-callout { color: red; } }';
    await expect(compileFailure(rawEditorCss)).rejects.toThrow(/styles\.editorCss is not part of AuthoringPlan v1/);

    const injection = plan();
    injection.styles.outcomes = [{ property: 'color', outcome: 'scoped-css', value: 'red; @import "https://example.test"' }];
    await expect(compileFailure(injection)).rejects.toMatchObject({
      reason: expect.stringContaining('not safe declarative style data'),
      source: expect.objectContaining({ path: 'styles.outcomes[0].value' }),
    });
  });
});
