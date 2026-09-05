import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
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
  BlockEditorProvider: unknown;
  BlockList: unknown;
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
  createElement: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => unknown;
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

type GeneratedComponent = () => unknown;

/**
 * Execute the exact JSX module emitted by the generator. The only transform is
 * the same JSX-to-JavaScript compilation a block build performs; no edit/save
 * implementation is re-created in this test.
 */
async function loadGeneratedComponent(
  compiled: CompiledAuthoringBlock,
  sourcePath: 'edit.js' | 'save.js',
  moduleOverrides: Record<string, unknown> = {},
): Promise<GeneratedComponent> {
  const source = compiled.files[sourcePath];
  expect(source, `expected generated source file ${sourcePath}`).toBeDefined();
  const { code } = await transform(source!, {
    loader: 'jsx',
    format: 'cjs',
    jsx: 'automatic',
    target: 'es2020',
    sourcefile: sourcePath,
  });
  const generatedModule: { exports: Record<string, unknown> } = { exports: {} };
  const generatedRequire = (specifier: string): unknown => moduleOverrides[specifier] ?? require(specifier);
  const execute = new Function('require', 'module', 'exports', `${code}\n//# sourceURL=generated-${sourcePath}`) as (
    moduleRequire: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => void;
  execute(generatedRequire, generatedModule, generatedModule.exports);
  expect(generatedModule.exports.default, `expected generated ${sourcePath} default export`).toBeTypeOf('function');
  return generatedModule.exports.default as GeneratedComponent;
}

async function registerCompiledBlock(
  wp: WpModules,
  compiled: CompiledAuthoringBlock,
): Promise<string> {
  const metadata = JSON.parse(compiled.files['block.json']!) as Record<string, unknown>;
  const name = metadata.name as string;
  const [edit, save] = await Promise.all([
    loadGeneratedComponent(compiled, 'edit.js'),
    loadGeneratedComponent(compiled, 'save.js'),
  ]);

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
  it('loads the emitted components and puts the InnerBlocks layout on their shared root', async () => {
    const compiled = compileAuthoringPlan(planFor('all'));
    const calls: Array<{ hook: string; props?: Record<string, unknown>; options?: Record<string, unknown> }> = [];
    const editBlockProps = { className: 'wp-block-block-runner-runtime-all', 'data-layout-owner': 'edit-root' };
    const saveBlockProps = { className: 'wp-block-block-runner-runtime-all', 'data-layout-owner': 'save-root' };
    const editChildren = { kind: 'editor-block-list' };
    const saveChildren = { kind: 'saved-native-children' };
    const blockEditor = {
      useBlockProps: Object.assign(() => {
        calls.push({ hook: 'useBlockProps' });
        return editBlockProps;
      }, {
        save: () => {
          calls.push({ hook: 'useBlockProps.save' });
          return saveBlockProps;
        },
      }),
      useInnerBlocksProps: Object.assign((props: Record<string, unknown>, options: Record<string, unknown>) => {
        calls.push({ hook: 'useInnerBlocksProps', props, options });
        return { ...props, className: `${props.className} block-editor-block-list__layout`, children: editChildren };
      }, {
        save: (props: Record<string, unknown>) => {
          calls.push({ hook: 'useInnerBlocksProps.save', props });
          return { ...props, className: `${props.className} saved-inner-blocks`, children: saveChildren };
        },
      }),
    };
    const [Edit, save] = await Promise.all([
      loadGeneratedComponent(compiled, 'edit.js', { '@wordpress/block-editor': blockEditor }),
      loadGeneratedComponent(compiled, 'save.js', { '@wordpress/block-editor': blockEditor }),
    ]);

    const edit = Edit() as { type: unknown; props: Record<string, unknown> };
    const saved = save() as { type: unknown; props: Record<string, unknown> };

    expect(edit).toMatchObject({ type: 'div', props: { className: expect.stringContaining('block-editor-block-list__layout'), children: editChildren } });
    expect(saved).toMatchObject({ type: 'div', props: { className: expect.stringContaining('saved-inner-blocks'), children: saveChildren } });
    expect(calls).toEqual([
      { hook: 'useBlockProps' },
      {
        hook: 'useInnerBlocksProps',
        props: editBlockProps,
        options: { allowedBlocks: compiled.allowedBlocks, template: compiled.template, templateLock: compiled.templateLock },
      },
      { hook: 'useBlockProps.save' },
      { hook: 'useInnerBlocksProps.save', props: saveBlockProps },
    ]);
  });

  it.each([false, 'insert', 'all', 'contentOnly'] as const satisfies readonly InnerBlocksLock[])(
    'registers, persists native edits, and enforces %s structural operations',
    async (templateLock) => {
      const wp = await getWp();
      const editor = require('@wordpress/block-editor') as BlockEditorRuntime;
      const data = require('@wordpress/data') as DataRuntime;
      const actions = data.dispatch(editor.store);
      const selectors = data.select(editor.store);
      const compiled = compileAuthoringPlan(planFor(templateLock));
      const name = await registerCompiledBlock(wp, compiled);
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

  it('renders the generated editor root as the direct InnerBlocks layout owner', async () => {
    const wp = await getWp();
    const editor = require('@wordpress/block-editor') as BlockEditorRuntime;
    const data = require('@wordpress/data') as DataRuntime;
    const element = require('@wordpress/element') as ElementRuntime;
    const actions = data.dispatch(editor.store);
    const selectors = data.select(editor.store);
    const plan = planFor(false);
    plan.root.children = plan.root.children?.slice(0, 3);
    const compiled = compileAuthoringPlan(plan);
    const name = await registerCompiledBlock(wp, compiled);
    const target = document.createElement('div');
    const editorRoot = element.createRoot(target);

    try {
      const mounted = mountCompiledBlock(wp, compiled, actions, selectors);
      const block = selectors.getBlock(mounted.rootId) as RuntimeBlock;
      document.body.append(target);
      element.flushSync(() => editorRoot.render(element.createElement(
        editor.BlockEditorProvider,
        { value: [block], settings: {}, onInput: () => {}, onChange: () => {} },
        element.createElement(editor.BlockList),
      )));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const outer = target.querySelector(`[data-block="${mounted.rootId}"]`);
      expect(outer).not.toBeNull();
      expect(outer?.classList.contains('block-editor-block-list__layout')).toBe(true);
      expect(outer?.querySelector(':scope > .block-editor-inner-blocks')).toBeNull();
      expect([...outer!.querySelectorAll(':scope > [data-block]')].map((child) => child.getAttribute('data-type')))
        .toEqual(['core/heading', 'core/paragraph', 'core/image']);
    } finally {
      editorRoot.unmount();
      target.remove();
      wp.unregisterBlockType(name);
    }
  });

  it('accepts pre-v9 saved markup with native children directly below the outer wrapper', async () => {
    const wp = await getWp();
    const compiled = compileAuthoringPlan(planFor(false));
    const name = await registerCompiledBlock(wp, compiled);
    const nativeChildren = wp.serialize(blocksFromTemplate(wp, compiled.template));
    // This is the canonical output from the previous `InnerBlocks.Content`
    // save contract: direct native child comments immediately inside the
    // generated wrapper, with no editor-only layout wrapper persisted.
    const legacyMarkup = `<!-- wp:${name} -->\n<div class="wp-block-${name.replace('/', '-')}">${nativeChildren}</div>\n<!-- /wp:${name} -->`;

    try {
      const reopened = wp.parse(legacyMarkup).map(runtimeBlock);

      expect(reopened).toHaveLength(1);
      expectValidTree(wp, reopened[0]!);
      expect(wp.serialize(reopened)).toBe(legacyMarkup);
    } finally {
      wp.unregisterBlockType(name);
    }
  });

  it('observes the WordPress 7.1 Edit pattern Inspector control in the contentOnly fixture', async () => {
    const wp = await getWp();
    const editor = require('@wordpress/block-editor') as BlockEditorRuntime;
    const data = require('@wordpress/data') as DataRuntime;
    const element = require('@wordpress/element') as ElementRuntime;
    const actions = data.dispatch(editor.store);
    const selectors = data.select(editor.store);
    const fixture = JSON.parse(await readFile(path.join(FIXTURES, 'content-only.plan.json'), 'utf8')) as AuthoringPlan;
    const compiled = compileAuthoringPlan(fixture);
    const name = await registerCompiledBlock(wp, compiled);
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

describe('saved authoring content across regeneration', () => {
  it('reopens v1 saved content under v2 editor defaults while preserving a user edit and stable child identities', async () => {
    const wp = await getWp();
    const editor = require('@wordpress/block-editor') as BlockEditorRuntime;
    const data = require('@wordpress/data') as DataRuntime;
    const actions = data.dispatch(editor.store);
    const selectors = data.select(editor.store);
    const v1 = compileAuthoringPlan(planFor('all'));
    const v2Plan = planFor('all');
    v2Plan.root.children![0]!.content = 'New default heading for future insertions';
    const v2 = compileAuthoringPlan(v2Plan);
    const name = await registerCompiledBlock(wp, v1);

    try {
      const initial = mountCompiledBlock(wp, v1, actions, selectors);
      actions.updateBlockAttributes(initial.childIds[0], { content: 'User edit retained from v1.' });
      const savedV1 = wp.serialize([selectors.getBlock(initial.rootId) as RuntimeBlock]);
      const savedFieldNames = (selectors.getBlock(initial.rootId) as RuntimeBlock).innerBlocks.map(runtimeBlock).map((block) => block.name);
      wp.unregisterBlockType(name);
      await registerCompiledBlock(wp, v2);

      const reopened = wp.parse(savedV1).map(runtimeBlock);
      expect(reopened).toHaveLength(1);
      expect(wp.serialize(reopened)).toContain('User edit retained from v1.');
      expectValidTree(wp, reopened[0]!);
      actions.resetBlocks(reopened);
      const reopenedRoot = (selectors.getBlocks() as RuntimeBlock[])[0]!;
      expect(reopenedRoot.innerBlocks.map(runtimeBlock).map((block) => block.name)).toEqual(savedFieldNames);
      expect(wp.serialize([reopenedRoot])).toContain('User edit retained from v1.');
      expect(wp.serialize([reopenedRoot])).toContain('Original paragraph');
      expect(wp.serialize([reopenedRoot])).toContain('https://example.test/original.jpg');
      actions.updateBlockAttributes(reopenedRoot.innerBlocks[1]!.clientId, { content: 'Second user edit after v2.' });
      expect(wp.serialize([selectors.getBlock(reopenedRoot.clientId) as RuntimeBlock])).toContain('Second user edit after v2.');
    } finally {
      wp.unregisterBlockType(name);
    }
  });
});
