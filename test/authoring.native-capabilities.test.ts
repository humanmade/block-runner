import { describe, expect, it } from 'vitest';
import { AuthoringGenerationError, compileRegisteredBlock, planRegisteredBlockOutput } from '../src/authoring/generate.js';
import type { AuthoringPlan } from '../src/authoring/schema.js';

function plan(): AuthoringPlan {
  return {
    version: 1, generatorVersion: '0.9.0', target: { name: 'acme/native-capabilities', title: 'Native capabilities' },
    structure: [{ id: 'copy', block: 'core/paragraph', attributes: { content: 'Native copy' } }],
    fields: [{ id: 'copy-content', label: 'Copy', mode: 'editable', node: 'copy', attribute: 'content' }],
    locking: { mode: 'none' }, styles: { strategy: 'native', outcomes: [] },
    pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [],
  };
}

function expectRejectedByPreviewAndGeneration(input: AuthoringPlan, reason: string, path: string): void {
  for (const compile of [planRegisteredBlockOutput, compileRegisteredBlock]) {
    try {
      compile(input);
      throw new Error('expected compiler failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoringGenerationError);
      expect(error).toMatchObject({ reason: expect.stringContaining(reason), source: { path } });
    }
  }
}

describe('static native composition capabilities', () => {
  it('rejects unknown blocks at the shared preview/write boundary', () => {
    const input = plan();
    input.structure[0]!.block = 'core/not-real';
    expectRejectedByPreviewAndGeneration(input, 'unknown-native-block', 'structure[0].block');
  });

  it('rejects opaque Custom HTML children while leaving page-content conversion to its fallback', () => {
    const input = plan();
    input.structure = [{ block: 'core/group', children: [{ block: 'core/html', attributes: { content: '<em>opaque</em>' } }] }];
    input.fields = [];
    expectRejectedByPreviewAndGeneration(input, 'unsupported-native-block', 'structure[0].children[0].block');
  });

  it('enforces registered parent/child restrictions where the pinned registry declares them', () => {
    const input = plan();
    input.structure = [{ block: 'core/list', children: [{ block: 'core/paragraph', attributes: { content: 'Wrong child' } }] }];
    input.fields = [];
    expectRejectedByPreviewAndGeneration(input, 'incompatible-native-child', 'structure[0].children[0].block');
  });

  it('enforces direct-parent and ancestor restrictions with exact plan paths', () => {
    const wrongParent = plan();
    wrongParent.structure = [{ block: 'core/group', children: [{ block: 'core/column' }] }];
    wrongParent.fields = [];
    expectRejectedByPreviewAndGeneration(wrongParent, 'incompatible-native-child', 'structure[0].children[0].block');

    const missingAncestor = plan();
    missingAncestor.structure = [{ block: 'core/group', children: [{ block: 'core/comment-author-name' }] }];
    missingAncestor.fields = [];
    expectRejectedByPreviewAndGeneration(missingAncestor, 'incompatible-native-child', 'structure[0].children[0].block');
  });

  it('does not mistake metadata attributes for native editor controls', () => {
    const missing = plan();
    missing.fields[0]!.attribute = 'doesNotExist';
    expectRejectedByPreviewAndGeneration(missing, 'unknown-native-attribute', 'fields[0].attribute');

    const metadataOnly = plan();
    metadataOnly.fields[0]!.attribute = 'placeholder';
    expectRejectedByPreviewAndGeneration(metadataOnly, 'unsupported-editor-field', 'fields[0].attribute');
  });

  it('accepts valid nested native content and records the pinned registry rather than claiming universal proof', () => {
    const input = plan();
    input.structure = [{ block: 'core/list', children: [{ id: 'item', block: 'core/list-item', attributes: { content: 'Native list item' } }] }];
    input.fields = [{ id: 'item-content', label: 'Item', mode: 'editable', node: 'item', attribute: 'content' }];
    const generated = compileRegisteredBlock(input);
    expect(generated.template).toEqual([['core/list', {}, [['core/list-item', { content: 'Native list item' }]]]]);
    expect(generated.manifest.registry).toMatchObject({ wordpress: '7.1', policy: '1' });
    expect(generated.manifest.registry.blockLibrary).toMatch(/^\d+\.\d+\.\d+$/);
    expect(generated.manifest.registry.blocks).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
