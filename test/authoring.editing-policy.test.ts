import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  compileRegisteredBlock,
  planRegisteredBlockOutput,
} from '../src/authoring/generate.js';
import { getWp } from '../src/headless/wp.js';
import type { AuthoringPlan } from '../src/authoring/schema.js';

const require = createRequire(import.meta.url);

function makePlan(): AuthoringPlan {
  return {
    version: 1,
    generatorVersion: '0.9.0',
    target: { name: 'acme/policy', title: 'Policy' },
    structure: [
      { id: 'title', block: 'core/heading', attributes: { content: 'A fixed heading' } },
      { id: 'copy', block: 'core/paragraph', attributes: { content: 'Editable copy' } },
    ],
    fields: [],
    locking: { mode: 'none' },
    styles: { strategy: 'native', outcomes: [] },
    pattern: { ready: false, overrides: [] },
    assets: [],
    files: [],
    warnings: [],
  };
}

describe('registered-block editing policy', () => {
  it('represents a fixed field with Gutenberg’s native block-level edit lock', () => {
    const input = makePlan();
    input.fields = [{
      id: 'title-content',
      label: 'Title',
      mode: 'fixed',
      node: 'title',
      attribute: 'content',
    }];

    const generated = compileRegisteredBlock(input);

    expect(generated.template[0]?.[1]).toMatchObject({
      content: 'A fixed heading',
      lock: { edit: true },
    });
    // Compilation works on a copy; the hash still describes the confirmed input plan.
    expect(input.structure[0]?.attributes).not.toHaveProperty('lock');
  });

  it('proves the generated edit lock through the installed Gutenberg selector', async () => {
    const wp = await getWp();
    const editor = require('@wordpress/block-editor') as { store: unknown };
    const data = require('@wordpress/data') as {
      dispatch: (store: unknown) => Record<string, (...args: unknown[]) => unknown>;
      select: (store: unknown) => Record<string, (...args: unknown[]) => unknown>;
    };
    const input = makePlan();
    input.fields = [{
      id: 'title-content',
      label: 'Title',
      mode: 'fixed',
      node: 'title',
      attribute: 'content',
    }];
    const generated = compileRegisteredBlock(input);
    const metadata = JSON.parse(generated.files.find((file) => file.path === 'block.json')!.content) as {
      name: string;
      [key: string]: unknown;
    };
    const name = metadata.name;
    expect(wp.registerBlockType(metadata, { edit: () => null, save: () => null })).toBeTruthy();
    const childTemplate = generated.template[0]!;
    const child = wp.createBlock(childTemplate[0], childTemplate[1], []);
    const root = wp.createBlock(name, {}, [child]) as unknown as { clientId: string };
    const actions = data.dispatch(editor.store) as unknown as {
      resetBlocks: (blocks: unknown[]) => void;
    };
    const selectors = data.select(editor.store) as unknown as {
      getBlockOrder: (clientId: string) => string[];
      getBlock: (clientId: string) => { attributes: Record<string, unknown> } | null;
      canEditBlock: (clientId: string) => boolean;
    };

    try {
      actions.resetBlocks([root]);
      const childId = selectors.getBlockOrder(root.clientId)[0]!;
      expect(selectors.getBlock(childId)?.attributes.lock).toEqual({ edit: true });
      expect(selectors.canEditBlock(childId)).toBe(false);
    } finally {
      actions.resetBlocks([]);
      wp.unregisterBlockType(name);
    }
  });

  it('combines a fixed edit lock with explicit native movement/removal locks', () => {
    const input = makePlan();
    input.structure[0]!.lock = { move: true, remove: true };
    input.fields = [{
      id: 'title-content',
      label: 'Title',
      mode: 'fixed',
      node: 'title',
      attribute: 'content',
    }];

    expect(compileRegisteredBlock(input).template[0]?.[1].lock).toEqual({
      edit: true,
      move: true,
      remove: true,
    });
  });

  it('rejects mixed fixed and editable fields on one native block', () => {
    const input = makePlan();
    input.fields = [
      { id: 'title-content', label: 'Title', mode: 'fixed', node: 'title', attribute: 'content' },
      { id: 'title-level', label: 'Heading level', mode: 'editable', node: 'title', attribute: 'level' },
    ];

    expect(() => planRegisteredBlockOutput(input)).toThrow('unsupported-fixed-field');
    expect(() => compileRegisteredBlock(input)).toThrow('unsupported-fixed-field');
  });

  it('rejects a fixed field that contradicts an existing native edit lock', () => {
    const input = makePlan();
    input.structure[0]!.attributes = {
      content: 'A fixed heading',
      lock: { edit: false },
    };
    input.fields = [{
      id: 'title-content',
      label: 'Title',
      mode: 'fixed',
      node: 'title',
      attribute: 'content',
    }];

    expect(() => compileRegisteredBlock(input)).toThrow('conflicting-fixed-field');
  });

  it('rejects an editable field that contradicts an existing native edit lock', () => {
    const input = makePlan();
    input.structure[0]!.attributes = {
      content: 'A locked heading',
      lock: { edit: true },
    };
    input.fields = [{
      id: 'title-content',
      label: 'Title',
      mode: 'editable',
      node: 'title',
      attribute: 'content',
    }];

    expect(() => compileRegisteredBlock(input)).toThrow('conflicting-editable-field');
  });

  it('rejects malformed native lock values instead of emitting unusable block attributes', () => {
    const input = makePlan();
    input.structure[0]!.attributes = {
      content: 'A heading',
      lock: { move: 'yes' },
    };

    expect(() => planRegisteredBlockOutput(input)).toThrow('invalid-native-lock');
    expect(() => compileRegisteredBlock(input)).toThrow('invalid-native-lock');
  });

  it.each([
    ['none', 'move', false],
    ['insert', 'remove', true],
    ['all', 'move', true],
    ['contentOnly', 'insert', true],
  ] as const)('rejects locking.%s=%s when it conflicts with native templateLock semantics', (mode, operation, value) => {
    const input = makePlan();
    input.locking = { mode, [operation]: value };

    expect(() => planRegisteredBlockOutput(input)).toThrow(`locking.${operation}`);
    expect(() => compileRegisteredBlock(input)).toThrow(`locking.${operation}`);
  });

  it('accepts the native operation flags when they accurately describe the selected templateLock', () => {
    const input = makePlan();
    input.locking = { mode: 'contentOnly', move: false, remove: false, insert: false };

    expect(() => compileRegisteredBlock(input)).not.toThrow();
    expect(compileRegisteredBlock(input).files.find((file) => file.path === 'edit.js')?.content)
      .toContain('const TEMPLATE_LOCK = "contentOnly"');
  });
});
