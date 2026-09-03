import { describe, expect, it } from 'vitest';
import { renderAuthoringPreview } from '../src/authoring/preview.js';
import { validateAuthoringPlan } from '../src/authoring/schema.js';

const plan = validateAuthoringPlan({
  version: 1,
  generatorVersion: '0.9.0-preview.1',
  target: {
    name: 'example/feature-grid',
    title: 'Feature grid',
    directory: 'blocks/feature-grid',
    description: 'A reusable feature grid.',
    category: 'design',
    textDomain: 'example',
    wordpress: '6.8',
  },
  structure: [
    {
      id: 'root',
      block: 'core/group',
      label: 'Feature grid',
      attributes: { layout: { type: 'constrained' } },
      lock: { move: false, remove: false },
      children: [{ id: 'heading', block: 'core/heading', label: 'Heading' }],
    },
  ],
  fields: [
    { id: 'heading', label: 'Heading', mode: 'editable', type: 'rich-text', node: 'heading', attribute: 'content' },
    { id: 'layout', label: 'Layout', mode: 'fixed', type: 'layout' },
    { id: 'accent', label: 'Accent', mode: 'override', type: 'color' },
  ],
  locking: { mode: 'contentOnly', move: false, remove: false, insert: false },
  styles: {
    strategy: 'mixed',
    outcomes: [
      { property: 'color', outcome: 'token', token: 'accent' },
      { property: 'display', outcome: 'scoped-css', value: 'grid', reason: 'No native support.' },
    ],
  },
  pattern: { ready: true, overrides: [{ field: 'accent', label: 'Accent' }] },
  assets: [{ id: 'logo', source: 'assets/logo.svg', kind: 'svg', destination: 'assets/logo.svg', status: 'ready', required: true }],
  files: [
    { path: 'block.json', kind: 'metadata', operation: 'create' },
    { path: 'src/edit.tsx', kind: 'editor', operation: 'replace' },
  ],
  warnings: ['The source logo needs a final license check.'],
});

describe('authoring preview', () => {
  it('renders the complete plan deterministically without ANSI sequences', () => {
    const first = renderAuthoringPreview(plan, { width: 80 });
    const second = renderAuthoringPreview(plan, { width: 80, color: true });

    expect(first).toBe(second);
    expect(first).toContain('Authoring plan preview');
    expect(first).toContain('Target');
    expect(first).toContain('Structure');
    expect(first).toContain('attributes:');
    expect(first).toContain('  `- core/heading');
    expect(first).toContain('Editable fields');
    expect(first).toContain('[fixed] Layout');
    expect(first).toContain('[editable] Heading');
    expect(first).toContain('[override] Accent');
    expect(first).toContain('Style outcomes');
    expect(first).toContain('Assets');
    expect(first).toContain('Pattern readiness');
    expect(first).toContain('Planned files');
    expect(first).toContain('Warnings');
    expect(first).toContain('No files written.');
    expect(first).toMatch(/Plan SHA-256: [a-f0-9]{64}/);
    expect(first).not.toContain('Confirmation SHA-256:');
    expect(first).not.toMatch(/\x1b\[/);
  });

  it('wraps to the supplied terminal width', () => {
    for (const width of [44, 12]) {
      const output = renderAuthoringPreview(plan, { width });
      expect(output.split('\n').every((line) => line.length <= width)).toBe(true);
    }
  });
});
