import { describe, expect, it } from 'vitest';
import { hashAuthoringPlan, serializeAuthoringPlan, validateAuthoringPlan } from '../src/authoring/schema.js';

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    generatorVersion: '0.9.0-preview.1',
    target: { name: 'example/notice', title: 'Notice' },
    structure: [{ block: 'core/group', id: 'root' }],
    fields: [{ id: 'message', label: 'Message', mode: 'editable' }],
    locking: { mode: 'contentOnly', move: false },
    styles: { strategy: 'native', outcomes: [{ property: 'color', outcome: 'token', token: 'primary' }] },
    pattern: { ready: true, overrides: [{ field: 'message' }] },
    assets: [],
    files: [{ path: 'block.json', operation: 'create' }],
    warnings: [],
    ...overrides,
  };
}

describe('AuthoringPlan schema', () => {
  it('canonicalizes object key order and binds every material field into the hash', () => {
    const first = plan();
    const reordered = {
      warnings: [],
      files: [{ operation: 'create', path: 'block.json' }],
      assets: [],
      pattern: { overrides: [{ field: 'message' }], ready: true },
      styles: { outcomes: [{ token: 'primary', outcome: 'token', property: 'color' }], strategy: 'native' },
      locking: { move: false, mode: 'contentOnly' },
      fields: [{ mode: 'editable', label: 'Message', id: 'message' }],
      structure: [{ id: 'root', block: 'core/group' }],
      target: { title: 'Notice', name: 'example/notice' },
      generatorVersion: '0.9.0-preview.1',
      version: 1,
    };

    expect(serializeAuthoringPlan(first)).toBe(serializeAuthoringPlan(reordered));
    expect(hashAuthoringPlan(first)).toBe(hashAuthoringPlan(reordered));
    expect(hashAuthoringPlan(plan({ warnings: ['review this'] }))).not.toBe(hashAuthoringPlan(first));
    expect(hashAuthoringPlan(plan({ generatorVersion: '0.9.0-preview.2' }))).not.toBe(hashAuthoringPlan(first));
  });

  it('rejects traversal, absolute, drive-relative, and conflicting planned paths', () => {
    for (const file of ['../escape.ts', '/tmp/escape.ts', 'C:\\escape.ts', 'C:escape.ts', 'src/../escape.ts', 'src\\escape.ts']) {
      expect(() => validateAuthoringPlan(plan({ files: [{ path: file }] }))).toThrow(/safe relative path/);
    }
    expect(() => validateAuthoringPlan(plan({ files: [{ path: 'src' }, { path: 'src/edit.ts' }] }))).toThrow(/descendant/);
  });
});
