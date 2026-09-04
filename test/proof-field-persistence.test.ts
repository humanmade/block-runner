import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the shipped browser helper's pure assertion, not a copied test implementation.
const helper = readFileSync(new URL('../scripts/proof-playwright.mjs', import.meta.url), 'utf8');
const start = helper.indexOf('function editedValuesPersisted(');
const end = helper.indexOf('\nfunction ', start + 1);
const check = runInNewContext(`(${helper.slice(start, end)})`) as (...args: unknown[]) => { ok: boolean; checks: unknown[] };
const matcherStart = helper.indexOf('function samePatternContent(');
const matcherEnd = helper.indexOf('\nasync function observePatternStructure', matcherStart);
const matchers = runInNewContext(`(() => { ${helper.slice(matcherStart, matcherEnd)}; return { samePatternContent, normalizeNativePatternContent }; })()`) as {
  samePatternContent: (actual: unknown, expected: unknown) => boolean;
  normalizeNativePatternContent: (content: unknown) => unknown;
};
const relStart = helper.indexOf('function nativeButtonRel(');
const relEnd = helper.indexOf('\nasync function waitForPatternOverrideValueIfScoped', relStart);
const nativeButtonRel = runInNewContext(`(${helper.slice(relStart, relEnd)})`) as (values: unknown) => string;
const settingsStart = helper.indexOf('async function openNativeLinkSettings(');
const settingsEnd = helper.indexOf('\nasync function ', settingsStart + 1);
const openSettings = runInNewContext(`(${helper.slice(settingsStart, settingsEnd)})`) as (control: unknown) => Promise<void>;
const before = { contentHash: 'before', treeHash: 'before' };
const heading = (name: string, content: string) => ({ name: 'core/heading', attributes: { metadata: { name }, content } });
const field = { path: 'title', metadataName: 'wanted', surface: 'richText', value: 'Updated' };
const state = (children: unknown[], others: unknown[] = []) => ({
  contentHash: 'after', treeHash: 'after', content: 'Updated appears somewhere',
  tree: [{ name: 'acme/hero', innerBlocks: children }, ...others],
});

describe('native field persistence scope', () => {
  it.each(['true', 'false'])('opens link settings without closing a remembered open drawer (%s)', async (initial) => {
    let expanded = initial;
    let clicks = 0;
    let waited = false;
    await openSettings({
      getByRole: () => ({ getAttribute: async () => expanded, click: async () => {
        clicks++; expanded = expanded === 'true' ? 'false' : 'true';
      } }),
      locator: () => ({ waitFor: async () => { expect(expanded).toBe('true'); waited = true; } }),
    });
    expect(clicks).toBe(initial === 'true' ? 0 : 1);
    expect(waited).toBe(true);
  });

  it('does not accept the requested value in a competing field or unrelated block', () => {
    const after = state([heading('wanted', 'Unchanged'), heading('other', 'Updated')], [heading('wanted', 'Updated')]);
    expect(check(before, after, [field], 'acme/hero').ok).toBe(false);
  });

  it('requires a unique native field and checks its exact persisted value', () => {
    const after = state([heading('wanted', 'Updated'), heading('other', 'Unchanged')]);
    expect(check(before, after, [field], 'acme/hero').ok).toBe(true);
    expect(check(before, after, [{ ...field, metadataName: undefined }], 'acme/hero').ok).toBe(false);
    expect(check(before, state([heading('wanted', 'Updated plus unexpected text')]), [field], 'acme/hero').ok).toBe(false);
  });

  it('requires all prepared media properties instead of skipping media persistence', () => {
    const media = { id: 7, url: 'https://example.test/image.png', alt: 'Description' };
    const input = { path: 'image', surface: 'media', media };
    expect(check(before, state([{ name: 'core/image', attributes: media }]), [input], 'acme/hero').ok).toBe(true);
    expect(check(before, state([{ name: 'core/image', attributes: { ...media, id: 8 } }]), [input], 'acme/hero').ok).toBe(false);
  });

  it('keeps Image title and caption in the exact native override contract', () => {
    const expected = {
      image: {
        id: 7,
        url: 'https://example.test/image.png',
        alt: 'Description',
        title: 'Native title',
        caption: 'Native caption',
      },
    };
    expect(matchers.samePatternContent(expected, expected)).toBe(true);
    expect(matchers.samePatternContent({ image: { ...expected.image, caption: 'Wrong caption' } }, expected)).toBe(false);
    expect(matchers.normalizeNativePatternContent(expected)).toEqual(expected);
  });

  it('matches WordPress native Button target and rel normalization', () => {
    const requested = { cta: { linkTarget: '_blank', rel: 'nofollow' } };
    const observed = { cta: { linkTarget: '_blank', rel: 'noopener nofollow' } };
    expect(nativeButtonRel(requested.cta)).toBe('noopener nofollow');
    expect(matchers.normalizeNativePatternContent(requested)).toEqual(observed);
    expect(matchers.samePatternContent(observed, requested)).toBe(true);
    expect(matchers.samePatternContent({ cta: { linkTarget: '', rel: 'nofollow' } }, requested)).toBe(false);
    expect(matchers.samePatternContent({ cta: { linkTarget: '_blank', rel: 'noopener' } }, requested)).toBe(false);
  });
});
