import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileRegisteredBlock, planRegisteredBlockOutput } from '../src/authoring/generate.js';
import { hashAuthoringPlan, validateAuthoringPlan, type AuthoringPlan, type AuthoringCssRule } from '../src/authoring/schema.js';
import { renderAuthoringPreview } from '../src/authoring/preview.js';
import { authoringRulesFromStylesheet, renderConfirmedStyleRules } from '../src/authoring/styles.js';
import { scanStylesheet, scopeStylesheet } from '../src/author/styles.js';
import { writeGeneratedRegisteredBlock } from '../src/authoring/destination.js';
import { PROOF_IMAGE_BASE64 } from '../src/proof/fixture-image.js';

const rule = (selector = '.card:hover', property = 'transform', value = 'translateY(-2px)'): AuthoringCssRule =>
  ({ kind: 'style', selector, declarations: [{ property, value }] });
const plan = (): AuthoringPlan => ({
  version: 1, generatorVersion: '0.9.0', target: { name: 'acme/cards', title: 'Cards' },
  structure: [{ block: 'core/group', attributes: { className: 'card' } }],
  fields: [], locking: { mode: 'contentOnly' }, styles: { strategy: 'mixed', outcomes: [], rules: [rule()] },
  pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [],
});

describe('confirmed residual CSS', () => {
  it('retains selectors, ordered fallbacks, importance, and nested responsive/container rules', () => {
    const input = plan();
    input.styles.rules = [rule('.card:hover, .card:focus-visible'), {
      kind: 'conditional', name: 'media', prelude: '(min-width: 48rem)', rules: [{
        kind: 'conditional', name: 'container', prelude: 'cards (inline-size > 30rem)', rules: [{
          kind: 'style', selector: '.card > .label::before', declarations: [
            { property: 'display', value: 'block' }, { property: 'display', value: 'grid', important: true },
            { property: 'content', value: '"New"' },
          ],
        }],
      }],
    }];
    const generated = compileRegisteredBlock(input);
    const css = generated.files.find(({ path }) => path === 'style.scss')!.content;
    expect(css).toContain('.wp-block-acme-cards .card:hover, .wp-block-acme-cards .card:focus-visible');
    expect(css).toContain('@media (min-width: 48rem)');
    expect(css).toContain('@container cards (inline-size > 30rem)');
    expect(css).toContain('.wp-block-acme-cards .card > .label::before { display: block; display: grid !important; content: "New"; }');
    expect(generated.sourcePlanHash).toBe(hashAuthoringPlan(input));
    expect(compileRegisteredBlock(input)).toEqual(generated);
  });

  it('transports the source scanner graph without double-scoping or reintroducing native declarations', () => {
    const source = scopeStylesheet(scanStylesheet('.card { color: red; transform: scale(1); } @supports (display: grid) { .card:hover { opacity: .8 } }'), {
      root: '.wp-block-acme-cards', disposition: ({ property }) => property === 'color' ? { outcome: 'native' } : undefined,
    });
    const rules = authoringRulesFromStylesheet(source.localRules);
    expect(renderConfirmedStyleRules(rules, source.root, []).css).toBe(source.css);
    expect(JSON.stringify(rules)).not.toContain('wp-block-acme-cards');
    expect(JSON.stringify(rules)).not.toContain('color');
    expect(source.ledger).toContainEqual(expect.objectContaining({ property: 'color', outcome: 'native' }));
  });

  it('supports escaped utility selectors without decoding them into new CSS syntax', () => {
    const input = plan();
    input.styles.rules = [rule('.\\32xl\\:open:is(#hero, .marker)')];
    expect(compileRegisteredBlock(input).files.find(({ path }) => path === 'style.scss')!.content)
      .toContain('.wp-block-acme-cards .\\32xl\\:open:is(#hero, .marker)');
  });

  it('keeps editor-only rules separate and shows all confirmed rules in the terminal preview', () => {
    const input = plan();
    input.styles.editorRules = [rule('.card:focus-within', 'outline', '2px solid blue')];
    const generated = compileRegisteredBlock(input);
    expect(generated.files.find(({ path }) => path === 'style.scss')!.content).not.toContain('outline');
    expect(generated.files.find(({ path }) => path === 'editor.scss')!.content).toContain('outline: 2px solid blue');
    const preview = renderAuthoringPreview(input, { width: 120 });
    expect(preview).toContain('Shared CSS');
    expect(preview).toContain('Editor-only CSS');
    expect(preview).toContain('.card:focus-within');
    expect(preview).toContain('outline: 2px solid blue');
    const hash = hashAuthoringPlan(input);
    input.styles.editorRules = [rule('.card:focus', 'outline', '2px solid blue')];
    expect(hashAuthoringPlan(input)).not.toBe(hash);
  });

  it('bundles a CSS-only image by confirmed hash without inventing a native media use', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-runner-css-assets-'));
    const bytes = Buffer.from(PROOF_IMAGE_BASE64, 'base64');
    const source = path.join(directory, 'photo.png');
    await writeFile(source, bytes);
    const input = plan();
    input.assets = [{ id: 'photo', source, destination: 'assets/photo.png', status: 'ready',
      sha256: createHash('sha256').update(bytes).digest('hex') }];
    input.styles.rules = [rule('.card', 'background-image', 'url("./assets/photo.png")')];
    expect(planRegisteredBlockOutput(input).files).toContainEqual({ path: 'assets/photo.png', operation: 'create' });
    const generated = compileRegisteredBlock(input);
    expect(generated.assets[0]!.content).toEqual(bytes);
    expect(generated.template[0]![1]).not.toHaveProperty('url');
    const output = path.join(directory, 'output');
    await writeGeneratedRegisteredBlock(output, generated);
    expect(await readFile(path.join(output, 'assets/photo.png'))).toEqual(bytes);
    await writeFile(source, 'changed');
    expect(() => planRegisteredBlockOutput(input)).toThrow('changed since confirmation');
  });

  it('requires remote CSS images to remain explicit external asset declarations', () => {
    const input = plan();
    input.styles.rules = [rule('.card', 'background-image', 'url("https://cdn.example/photo.png")')];
    expect(() => planRegisteredBlockOutput(input)).toThrow('not confirmed');
    input.assets = [{ id: 'remote-photo', source: 'https://cdn.example/photo.png', status: 'external' }];
    expect(compileRegisteredBlock(input).assets).toEqual([]);
  });

  it.each([
    rule('body'), rule('.card, html'), rule('.card { color: red; } body'), rule('.card\\'),
    rule('.card:hover('), rule('.wp-block-acme-cards .card'), rule('.card', 'color', 'red; display:none'),
    rule('.card', 'color', '#{$secret}'), rule('.card', 'color', 'red /* hidden */'),
    rule('.card', 'color', 'red !important'), rule('.card', 'behavior', 'url("https://example.com/x")'),
    rule('.card', 'background-image', 'url("../outside.png")'), rule('.card', 'width', 'expression(alert(1))'),
    rule('.card', 'background-image', 'u\\72l("javascript:alert(1)")'),
    rule('.card', 'width', 'random(100)'), rule('.card', 'color', 'call("unreviewed")'),
    { kind: 'conditional', name: 'media', prelude: '(width > 1px) {} @import "x"', rules: [rule()] },
    { kind: 'conditional', name: 'media', prelude: '(width > random(100))', rules: [rule()] },
  ])('rejects unsafe CSS before both preview and generation: %j', (invalid) => {
    const input = plan();
    input.styles.rules = [invalid as AuthoringCssRule];
    expect(() => planRegisteredBlockOutput(input)).toThrow();
    expect(() => compileRegisteredBlock(input)).toThrow();
  });

  it('refuses unknown rule fields and condition kinds instead of dropping them from the hash', () => {
    const input = plan();
    expect(() => validateAuthoringPlan({ ...input, styles: { ...input.styles, rules: [{ ...rule(), css: 'body{}' }] } })).toThrow();
    expect(() => validateAuthoringPlan({ ...input, styles: { ...input.styles, rules: [{ kind: 'conditional', name: 'import', prelude: 'x', rules: [] }] } })).toThrow();
  });

  it('also refuses unsupported legacy style outcomes during preview, not only when writing', () => {
    const input = plan();
    input.styles.outcomes = [{ property: 'behavior', outcome: 'scoped-css', value: 'url(x)' }];
    expect(() => planRegisteredBlockOutput(input)).toThrow('unsupported-style-outcome');
  });
});
