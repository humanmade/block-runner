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
    wordpress: '7.1',
  },
  source: { entry: 'design.html', sha256: 'a'.repeat(64), format: 'html' },
  coverage: {
    stylesheet: { entry: 'design.html', sha256: 'b'.repeat(64) },
    styles: [{ property: 'color', value: 'red', outcome: 'native', scope: 'shared', atRules: [] }],
    assets: [{ reference: 'logo.svg', kind: 'image', outcome: 'prepared', sha256: 'c'.repeat(64) }],
  },
  structure: [
    {
      id: 'root',
      block: 'core/group',
      label: 'Feature grid',
      attributes: { layout: { type: 'constrained' } },
      lock: { move: true, remove: false },
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
    expect(first).toContain('Source SHA-256: ' + 'a'.repeat(64));
    expect(first).toContain('Structure');
    expect(first).toContain('[move=blocked,remove=allowed]');
    expect(first).toContain('locking: contentOnly (move=blocked, remove=blocked, insert=blocked)');
    expect(first).toContain('attributes:');
    expect(first).toContain('  `- core/heading');
    expect(first).toContain('Editable fields');
    expect(first).toContain('[fixed] Layout');
    expect(first).toContain('[editable] Heading');
    expect(first).toContain('[override] Accent');
    expect(first).toContain('Style outcomes');
    expect(first).toContain('Assets');
    expect(first).toContain('Analysis coverage');
    expect(first).toContain('styles: 1 (native 1)');
    expect(first).toContain('assets: 1 (prepared 1)');
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

  it('leads with a compact review summary while retaining every approval detail before the hash', () => {
    const reviewed = validateAuthoringPlan({
      ...plan,
      styles: {
        ...plan.styles,
        outcomes: [...plan.styles.outcomes, { property: 'filter', outcome: 'dropped', reason: 'Unsupported.' }],
      },
      coverage: {
        ...plan.coverage!,
        styles: [...plan.coverage!.styles,
          { property: 'display', value: 'grid', outcome: 'scoped-css', scope: 'shared', atRules: [] },
          { property: 'outline', value: '2px solid blue', outcome: 'scoped-css', scope: 'editor', atRules: [] },
          { property: 'position', value: 'fixed', outcome: 'blocked', scope: 'shared', atRules: [] },
        ],
        assets: [...plan.coverage!.assets, {
          reference: 'remote.png', kind: 'image', outcome: 'unresolved', reason: 'No approved asset.',
        }],
      },
    });
    const confirmation = 'e'.repeat(64);
    const output = renderAuthoringPreview(reviewed, {
      width: 160,
      destination: '/work/generated/feature-grid',
      touchedFiles: [
        { path: '/work/generated/feature-grid/block.json', operation: 'create', exists: false },
        { path: '/work/generated/feature-grid/edit.js', operation: 'replace', exists: true },
      ],
      confirmationHash: confirmation,
    });

    expect(output).toContain('Review summary');
    expect(output).toContain('Editing: 1 fixed, 1 editable, 1 override fields.');
    expect(output).toContain('Unresolved decisions and losses: 3 style or asset issues; 1 warning.');
    expect(output).toContain('Asset ownership: 1 package-owned, 0 external, 0 licensed bundled fonts.');
    expect(output).toContain('Style ownership: 1 native-owned, 1 package-owned shared, 1 editor-only.');
    expect(output).toContain('/work/generated/feature-grid/block.json [create; path currently absent]');
    expect(output).toContain('/work/generated/feature-grid/edit.js [replace; existing file; explicit hash-bound replacement approval required]');
    expect(output).toContain(`Confirmation SHA-256: ${confirmation}`);
    expect(output.indexOf('Review summary')).toBeLessThan(output.indexOf('Structure'));
    expect(output.indexOf('Structure')).toBeLessThan(output.indexOf('Warnings'));
    expect(output.indexOf('Warnings')).toBeLessThan(output.indexOf(`Confirmation SHA-256: ${confirmation}`));
  });

  it('shows the asset binding and license record for a confirmed font face', () => {
    const fontPlan = validateAuthoringPlan({
      ...plan,
      styles: {
        ...plan.styles,
        fonts: [{ assetId: 'body-font', family: 'block-runner-example-feature-grid-inter', fontDisplay: 'swap' }],
      },
      assets: [{
        id: 'body-font', source: '/design/Inter.woff2', kind: 'font', destination: 'assets/Inter.woff2', status: 'ready',
        sha256: 'd'.repeat(64), fontLicense: { ownership: 'Example', license: 'OFL-1.1', notice: 'Keep this notice.' },
      }],
    });
    const output = renderAuthoringPreview(fontPlan, { width: 100 });

    expect(output).toContain('Licensed fonts (shared by editor and frontend):');
    expect(output).toContain('block-runner-example-feature-grid-inter <- body-font (fontDisplay swap)');
    expect(output).toContain('[font] /design/Inter.woff2 -> assets/Inter.woff2 [ready] license OFL-1.1 (Example)');
  });
});
