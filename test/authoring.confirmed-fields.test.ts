import { describe, expect, it } from 'vitest';
import { compileRegisteredBlock, planRegisteredBlockOutput } from '../src/authoring/generate.js';
import { hashAuthoringPlan, type AuthoringPlan } from '../src/authoring/schema.js';

function plan(): AuthoringPlan {
  return {
    version: 1, generatorVersion: '0.9.0', target: { name: 'acme/hero', title: 'Hero' },
    structure: [{ id: 'title', block: 'core/heading', attributes: { content: 'Original' }, lock: { remove: true } }],
    fields: [{ id: 'title-content', label: 'Title', mode: 'override', node: 'title', attribute: 'content', default: 'Confirmed title' }],
    pattern: { ready: true, overrides: [{ field: 'title-content' }] },
    locking: { mode: 'insert' }, styles: { strategy: 'native', outcomes: [] }, assets: [], files: [], warnings: [],
  };
}

describe('confirmed editor fields in the production generator', () => {
  it('preserves a confirmed direct-child insertion policy and refuses contradictory templates', () => {
    const input = plan();
    input.allowedBlocks = ['core/heading', 'core/image'];
    const generated = compileRegisteredBlock(input);
    expect(JSON.parse(generated.files.find(({ path }) => path === 'block.json')!.content).allowedBlocks)
      .toEqual(['core/heading', 'core/image']);
    expect(generated.sourcePlanHash).toBe(hashAuthoringPlan(input));
    input.allowedBlocks = ['core/image'];
    expect(() => planRegisteredBlockOutput(input)).toThrow('initial-template-not-allowed');
    input.allowedBlocks = ['core/heading', 'core/heading'];
    expect(() => compileRegisteredBlock(input)).toThrow('duplicate-allowed-block');
  });

  it('emits confirmed defaults, native bindings, and both structural locks without changing the plan hash', () => {
    const input = plan();
    const hash = hashAuthoringPlan(input);
    const result = compileRegisteredBlock(input);
    expect(result.sourcePlanHash).toBe(hash);
    expect(hashAuthoringPlan(input)).toBe(hash);
    expect(result.template[0]?.[1]).toMatchObject({
      content: 'Confirmed title', lock: { remove: true },
      metadata: { name: expect.any(String), bindings: { __default: { source: 'core/pattern-overrides' } } },
    });
    expect(result.files.find((file) => file.path === 'edit.js')?.content).toContain('const TEMPLATE_LOCK = "insert"');
    expect(result.files.find((file) => file.path === 'edit.js')?.content).toContain('Confirmed title');
  });

  it('gives separate fields on one native node the same stable override name', () => {
    const input = plan();
    input.structure = [{ id: 'cta', block: 'core/button', attributes: { text: 'Go', url: 'https://example.com' } }];
    input.fields = ['text', 'url', 'linkTarget', 'rel'].map((attribute) => ({ id: attribute, label: attribute, mode: 'override', node: 'cta', attribute }));
    input.pattern.overrides = input.fields.map(({ id }) => ({ field: id }));
    expect(compileRegisteredBlock(input).template[0]?.[1].metadata).toMatchObject({
      name: expect.any(String), bindings: { __default: { source: 'core/pattern-overrides' } },
    });
  });

  it('rejects partial native-region overrides instead of silently enabling unconfirmed fields', () => {
    const input = plan();
    input.structure[0]!.block = 'core/button';
    input.fields[0]!.attribute = 'text';
    expect(() => compileRegisteredBlock(input)).toThrow('partial-pattern-override');
  });

  it.each(['missing-node', 'missing-field', 'container', 'fixed', 'unconfirmed', 'unsafe-default'])(
    'rejects %s before either preview or generation can promise success', (invalid) => {
      const input = plan();
      if (invalid === 'missing-node') input.fields[0]!.node = 'absent';
      if (invalid === 'missing-field') input.pattern.overrides[0]!.field = 'absent';
      if (invalid === 'container') input.structure[0]!.block = 'core/group';
      if (invalid === 'fixed') input.fields[0]!.mode = 'fixed';
      if (invalid === 'unconfirmed') input.pattern.ready = false;
      if (invalid === 'unsafe-default') {
        input.structure[0]!.block = 'core/button';
        input.fields[0]!.attribute = 'url';
        input.fields[0]!.default = 'javascript:alert(1)';
      }
      expect(() => planRegisteredBlockOutput(input)).toThrow();
      expect(() => compileRegisteredBlock(input)).toThrow();
    },
  );
});
