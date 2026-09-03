import { describe, expect, it } from 'vitest';
import {
  compileAuthoringPlan,
  patternOverrideContent,
  validatePatternOverrideContract,
} from '../src/index.js';
import type { AuthoringPlan, AuthoringTemplate } from '../src/types.js';

const plan: AuthoringPlan = {
  name: 'acme/pattern-hero',
  title: 'Pattern hero',
  templateLock: 'contentOnly',
  root: {
    path: 'hero',
    role: 'wrapper',
    children: [
      { path: 'hero.title', role: 'heading', content: 'Canonical heading' },
      {
        path: 'hero.image',
        role: 'image',
        attributes: { id: 42 },
        url: 'https://example.test/canonical.jpg',
        alt: 'Canonical image',
      },
      {
        path: 'hero.cta',
        role: 'button',
        content: 'Canonical action',
        url: 'https://example.test/canonical',
      },
    ],
  },
};

describe('WordPress 7.1 pattern overrides', () => {
  it('binds only supported native Core content fields with stable unique names', () => {
    const first = compileAuthoringPlan(plan);
    const second = compileAuthoringPlan(JSON.parse(JSON.stringify(plan)) as AuthoringPlan);

    expect(first.template).toEqual(second.template);
    expect(first.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([]);
    expect(first.templateLock).toBe('contentOnly');
    expect(first.files['template.js']).toContain('core/pattern-overrides');
    expect(first.files['template.js']).not.toContain('innerBlocks');

    const contract = validatePatternOverrideContract(first.template, first.editableFields);
    expect(contract).toMatchObject({ ok: true });
    expect(contract.bindings).toHaveLength(6);
    expect(new Set(contract.bindings.map((binding) => binding.name)).size).toBe(3);
    expect(contract.bindings.map((binding) => `${binding.block}.${binding.attribute}`)).toEqual([
      'core/heading.content',
      'core/image.id',
      'core/image.url',
      'core/image.alt',
      'core/button.text',
      'core/button.url',
    ]);
    expect(first.editableFields.every((field) => field.overrideName)).toBe(true);
  });

  it('uses WordPress core/block.content shape for each instance instead of an innerBlocks binding', () => {
    const compiled = compileAuthoringPlan(plan);
    const title = compiled.editableFields.find((field) => field.path === 'hero.title')!.overrideName!;
    const image = compiled.editableFields.find((field) => field.path === 'hero.image')!.overrideName!;
    const cta = compiled.editableFields.find((field) => field.path === 'hero.cta')!.overrideName!;

    const first = patternOverrideContent({
      [title]: { content: 'First instance' },
      [image]: { id: 101, url: 'https://example.test/first.jpg', alt: 'First image' },
      [cta]: { text: 'First action', url: 'https://example.test/first' },
    });
    const second = patternOverrideContent({
      [title]: { content: 'Second instance' },
      [image]: { id: 202, url: 'https://example.test/second.jpg', alt: 'Second image' },
      [cta]: { text: 'Second action', url: 'https://example.test/second' },
    });

    expect(first).not.toEqual(second);
    expect(first).not.toHaveProperty('innerBlocks');
    expect(second).not.toHaveProperty('innerBlocks');
    expect(first[title]).toEqual({ content: 'First instance' });
    expect(second[cta]).toEqual({ text: 'Second action', url: 'https://example.test/second' });
  });

  it('fails closed when required Core override support is removed', () => {
    const compiled = compileAuthoringPlan(plan);
    const broken = JSON.parse(JSON.stringify(compiled.template)) as AuthoringTemplate;
    const heading = broken[0]!;
    delete ((heading[1].metadata as { bindings: Record<string, unknown> }).bindings.content);

    const contract = validatePatternOverrideContract(broken, compiled.editableFields);
    expect(contract.ok).toBe(false);
    expect(contract.errors.join('\n')).toMatch(/Required override hero\.title\.content is missing/i);
  });

  it('does not make structural containers overrideable', () => {
    const result = compileAuthoringPlan({
      ...plan,
      root: {
        ...plan.root,
        children: [{ path: 'hero.layout', role: 'group', patternOverrides: true }],
      },
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      level: 'error',
      code: 'unsupported-pattern-override',
    }));
    expect(validatePatternOverrideContract(result.template, result.editableFields).bindings).toEqual([]);
  });
});
