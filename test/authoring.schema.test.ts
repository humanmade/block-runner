import { describe, expect, it } from 'vitest';
import { hashAuthoringPlan, serializeAuthoringPlan, validateAuthoringPlan } from '../src/authoring/schema.js';
import { compileRegisteredBlock } from '../src/authoring/generate.js';

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

  it('keeps executable source out of declarative file declarations', () => {
    const input = validateAuthoringPlan(plan({
      structure: [], fields: [], locking: { mode: 'none' }, styles: { strategy: 'native', outcomes: [] },
      pattern: { ready: false, overrides: [] }, files: [{ path: 'block.json', content: '{}' }],
    }));
    expect(() => compileRegisteredBlock(input)).toThrow(/plan file content is not accepted/);
  });

  it('validates and hash-binds source identity and the complete analysis ledger', () => {
    const sourced = validateAuthoringPlan(plan({
      source: { entry: 'design.html', sha256: 'a'.repeat(64), format: 'html' },
      coverage: {
        stylesheet: { entry: 'design.html', sha256: 'b'.repeat(64) },
        styles: [{ property: 'color', value: 'red', outcome: 'native', scope: 'shared', atRules: [] }],
        assets: [{ reference: 'logo.svg', kind: 'image', outcome: 'prepared', sha256: 'c'.repeat(64), destination: 'assets/logo.svg' }],
      },
    }));
    expect(sourced.source?.sha256).toBe('a'.repeat(64));
    expect(sourced.coverage?.styles[0]).toMatchObject({ scope: 'shared', outcome: 'native' });
    expect(hashAuthoringPlan(sourced)).not.toBe(hashAuthoringPlan(plan()));
    expect(() => validateAuthoringPlan(plan({ coverage: { styles: [], assets: [] } }))).toThrow(/requires a hash-bound/);
    expect(() => validateAuthoringPlan(plan({ source: { entry: 'design.html', sha256: 'not-a-hash', format: 'html' } }))).toThrow(/SHA-256/);
  });

  it('hash-binds the target style context without treating it as writable theme configuration', () => {
    const sourced = validateAuthoringPlan(plan({
      source: { entry: 'design.html', sha256: 'a'.repeat(64), format: 'html' },
      coverage: { styles: [], assets: [], styleContext: {
        theme: { slug: 'example', version: '1.0', settingsSha256: 'b'.repeat(64) },
        viewports: { mobile: { max: '599px' }, tablet: { min: '600px', max: '1023px' } },
        unresolvedVariables: ['--brand-accent'],
        limitations: ['No global reset was imported.'],
      } },
    }));
    expect(sourced.coverage?.styleContext?.viewports?.tablet?.max).toBe('1023px');
    const changed = structuredClone(sourced);
    changed.coverage!.styleContext!.theme!.settingsSha256 = 'c'.repeat(64);
    expect(hashAuthoringPlan(changed)).not.toBe(hashAuthoringPlan(sourced));
  });

  it('pins registered-block plans to WordPress 7.1 and defaults omitted targets to that pin', () => {
    expect(validateAuthoringPlan(plan()).target.wordpress).toBe('7.1');
    expect(validateAuthoringPlan(plan({ target: { name: 'example/notice', title: 'Notice', wordpress: '7.1.1' } })).target.wordpress)
      .toBe('7.1.1');
    expect(() => validateAuthoringPlan(plan({ target: { name: 'example/notice', title: 'Notice', wordpress: '6.8' } })))
      .toThrow(/must target WordPress 7\.1/);
  });

  it('keeps native metadata permissive, canonical, and hash-bound before static capability validation', () => {
    const input = plan({ target: {
      name: 'example/notice', title: 'Notice', metadata: { keywords: ['notice'], experimentalFlag: { enabled: true } },
    } });
    const normalized = validateAuthoringPlan(input);
    expect(normalized.target.metadata).toEqual({ keywords: ['notice'], experimentalFlag: { enabled: true } });
    expect(hashAuthoringPlan(input)).not.toBe(hashAuthoringPlan(plan()));
    expect(() => compileRegisteredBlock({ ...normalized, fields: [], pattern: { ready: false, overrides: [] } })).not.toThrow();
    expect(validateAuthoringPlan({ ...input, target: { ...input.target as object, metadata: { variations: 'file:./variations.php' } } }).target.metadata?.variations)
      .toBe('file:./variations.php');
  });

  it('keeps font faces bound to a licensed plan asset rather than a duplicated source path', () => {
    const input = plan({
      styles: {
        strategy: 'mixed',
        outcomes: [],
        fonts: [{ assetId: 'inter', family: 'block-runner-example-notice-inter', fontDisplay: 'swap' }],
      },
      assets: [{
        id: 'inter', source: '/design/Inter.woff2', kind: 'font', destination: 'assets/Inter.woff2', status: 'ready',
        sha256: 'c'.repeat(64), fontLicense: { ownership: 'Fixture rights holder', license: 'OFL-1.1', notice: 'Keep this record.' },
      }],
    });
    expect(validateAuthoringPlan(input).styles.fonts?.[0]).toMatchObject({ assetId: 'inter', family: 'block-runner-example-notice-inter' });
    expect(hashAuthoringPlan(input)).not.toBe(hashAuthoringPlan(plan()));
    expect(() => validateAuthoringPlan({ ...input, styles: { strategy: 'mixed', outcomes: [], fonts: [{ family: 'Inter' }] } })).toThrow(/assetId/);
    expect(() => validateAuthoringPlan({ ...input, styles: { strategy: 'mixed', outcomes: [], fonts: [{ assetId: 'missing', family: 'block-runner-example-notice-inter' }] } }))
      .toThrow(/must reference an asset/);
    expect(() => validateAuthoringPlan({ ...input, assets: [{
      id: 'inter', source: '/design/Inter.woff2', kind: 'image', destination: 'assets/Inter.woff2', status: 'ready',
      sha256: 'c'.repeat(64), fontLicense: { ownership: 'Fixture rights holder', license: 'OFL-1.1', notice: 'Keep this record.' },
    }] }))
      .toThrow(/must reference an asset whose kind is "font"/);
  });
});
