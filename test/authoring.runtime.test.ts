import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileAuthoringPlan } from '../src/index.js';
import { getWp } from '../src/headless/wp.js';
import type { AuthoringPlan, AuthoringTemplate, CompiledAuthoringBlock, InnerBlocksLock, WpBlock, WpModules } from '../src/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'authoring');
const require = createRequire(import.meta.url);

type RuntimeBlock = WpBlock & { clientId: string; innerBlocks: RuntimeBlock[] };

type BlockEditorRuntime = {
  store: unknown;
  BlockInspector: unknown;
  useBlockProps: (() => Record<string, unknown>) & { save: () => Record<string, unknown> };
  useInnerBlocksProps: {
    (props: Record<string, unknown>, options: Record<string, unknown>): Record<string, unknown>;
    save: (props: Record<string, unknown>) => Record<string, unknown>;
  };
};

type DataRuntime = {
  dispatch: (store: unknown) => Record<string, (...args: unknown[]) => unknown>;
  select: (store: unknown) => Record<string, (...args: unknown[]) => unknown>;
};

type ElementRuntime = {
  createElement: (type: unknown, props?: Record<string, unknown>) => unknown;
  createRoot: (container: Element) => { render: (element: unknown) => void; unmount: () => void };
  flushSync: (callback: () => void) => void;
};

const lockExpectations = {
  insert: { insert: false, remove: false, move: true },
  all: { insert: false, remove: false, move: false },
  contentOnly: { insert: false, remove: false, move: false },
} as const;

function expectedStructuralOperations(templateLock: InnerBlocksLock): { insert: boolean; remove: boolean; move: boolean } {
  return templateLock === false ? { insert: true, remove: true, move: true } : lockExpectations[templateLock];
}

function planFor(templateLock: InnerBlocksLock): AuthoringPlan {
  return {
    name: `block-runner/runtime-${templateLock === false ? 'unlocked' : templateLock.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    title: 'Runtime acceptance block',
    templateLock,
    root: {
      path: 'runtime',
      role: 'wrapper',
      children: [
        { path: 'runtime.title', role: 'heading', content: 'Original heading', level: 2 },
        { path: 'runtime.copy', role: 'paragraph', content: 'Original paragraph' },
        { path: 'runtime.image', role: 'image', url: 'https://example.test/original.jpg', alt: 'Original image' },
        { path: 'runtime.quote', role: 'quote', content: 'Original native quote' },
      ],
    },
  };
}

function runtimeBlock(block: WpBlock): RuntimeBlock {
  return block as RuntimeBlock;
}

function blocksFromTemplate(wp: WpModules, template: AuthoringTemplate): RuntimeBlock[] {
  return template.map(([name, attributes, children]) =>
    runtimeBlock(wp.createBlock(name, attributes, children ? blocksFromTemplate(wp, children) : [])),
  );
}

function registerCompiledBlock(
  wp: WpModules,
  compiled: CompiledAuthoringBlock,
  editor: BlockEditorRuntime,
  element: ElementRuntime,
): string {
  const metadata = JSON.parse(compiled.files['block.json']!) as Record<string, unknown>;
  const name = metadata.name as string;

  const edit = () => {
    const blockProps = editor.useBlockProps();
    const innerBlocksProps = editor.useInnerBlocksProps(blockProps, {
      allowedBlocks: compiled.allowedBlocks,
      template: compiled.template,
      templateLock: compiled.templateLock,
    });
    return element.createElement('div', innerBlocksProps);
  };
  const save = () => {
    const blockProps = editor.useBlockProps.save();
    const innerBlocksProps = editor.useInnerBlocksProps.save(blockProps);
    return element.createElement('div', innerBlocksProps);
  };

  expect(wp.registerBlockType(metadata, { edit, save })).toBeTruthy();
  return name;
}

function mountCompiledBlock(
  wp: WpModules,
  compiled: CompiledAuthoringBlock,
  actions: Record<string, (...args: unknown[]) => unknown>,
  selectors: Record<string, (...args: unknown[]) => unknown>,
): { rootId: string; childIds: string[] } {
  const metadata = JSON.parse(compiled.files['block.json']!) as { name: string };
  const block = runtimeBlock(wp.createBlock(metadata.name, {}, blocksFromTemplate(wp, compiled.template)));
  actions.resetBlocks([block]);
  actions.updateBlockListSettings(block.clientId, {
    allowedBlocks: compiled.allowedBlocks,
    template: compiled.template,
    templateLock: compiled.templateLock,
  });

  return {
    rootId: block.clientId,
    childIds: selectors.getBlockOrder(block.clientId) as string[],
  };
}

function expectValidTree(wp: WpModules, block: RuntimeBlock): void {
  expect(wp.validateBlock(block)[0]).toBe(true);
  for (const child of block.innerBlocks) expectValidTree(wp, child);
}

describe('generated registered blocks in WordPress 7.1', () => {
  it.each([false, 'insert', 'all', 'contentOnly'] as const satisfies readonly InnerBlocksLock[])(
    'registers, persists native edits, and enforces %s structural operations',
    async (templateLock) => {
      const wp = await getWp();
      const editor = require('@wordpress/block-editor') as BlockEditorRuntime;
      const data = require('@wordpress/data') as DataRuntime;
      const element = require('@wordpress/element') as ElementRuntime;
      const actions = data.dispatch(editor.store);
      const selectors = data.select(editor.store);
      const compiled = compileAuthoringPlan(planFor(templateLock));
      const name = registerCompiledBlock(wp, compiled, editor, element);
      const expected = expectedStructuralOperations(templateLock);

      try {
        const persisted = mountCompiledBlock(wp, compiled, actions, selectors);
        actions.updateBlockAttributes(persisted.childIds[0], { content: 'Edited after reopening.' });
        const saved = wp.serialize([selectors.getBlock(persisted.rootId) as RuntimeBlock]);
        const reopened = wp.parse(saved).map(runtimeBlock);

        expect(saved).toContain('Edited after reopening.');
        expect(reopened).toHaveLength(1);
        expect(wp.serialize(reopened)).toContain('Edited after reopening.');
        expect(wp.serialize(reopened)).toBe(saved);
        expectValidTree(wp, reopened[0]!);

        const inserted = mountCompiledBlock(wp, compiled, actions, selectors);
        const beforeInsert = selectors.getBlockOrder(inserted.rootId) as string[];
        actions.insertBlock(wp.createBlock('core/image', { url: 'https://example.test/added.jpg', alt: 'Added image' }), undefined, inserted.rootId, false);
        expect(selectors.getBlockOrder(inserted.rootId)).toHaveLength(beforeInsert.length + Number(expected.insert));

        const removed = mountCompiledBlock(wp, compiled, actions, selectors);
        actions.removeBlock(removed.childIds[0], false);
        expect((selectors.getBlockOrder(removed.rootId) as string[]).includes(removed.childIds[0]!)).toBe(!expected.remove);

        const moved = mountCompiledBlock(wp, compiled, actions, selectors);
        actions.moveBlockToPosition(moved.childIds[0], moved.rootId, moved.rootId, 1);
        expect((selectors.getBlockOrder(moved.rootId) as string[])[1]).toBe(expected.move ? moved.childIds[0] : moved.childIds[1]);
      } finally {
        wp.unregisterBlockType(name);
      }
    },
  );

  it('observes the WordPress 7.1 Edit pattern Inspector control in the contentOnly fixture', async () => {
    const wp = await getWp();
    const editor = require('@wordpress/block-editor') as BlockEditorRuntime;
    const data = require('@wordpress/data') as DataRuntime;
    const element = require('@wordpress/element') as ElementRuntime;
    const actions = data.dispatch(editor.store);
    const selectors = data.select(editor.store);
    const fixture = JSON.parse(await readFile(path.join(FIXTURES, 'content-only.plan.json'), 'utf8')) as AuthoringPlan;
    const compiled = compileAuthoringPlan(fixture);
    const name = registerCompiledBlock(wp, compiled, editor, element);
    const target = document.createElement('div');
    const inspector = element.createRoot(target);

    try {
      const mounted = mountCompiledBlock(wp, compiled, actions, selectors);
      actions.selectBlock(mounted.rootId);

      document.body.append(target);
      element.flushSync(() => inspector.render(element.createElement(editor.BlockInspector)));
      expect(target.textContent).toContain('Edit pattern');
    } finally {
      inspector.unmount();
      target.remove();
      wp.unregisterBlockType(name);
    }
  });
});
