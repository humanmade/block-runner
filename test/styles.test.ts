import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import type { RuleContext } from '../src/types.js';
import { querySupports } from '../src/styles/capabilities.js';
import { expandShorthand, parseInlineStyle } from '../src/styles/parse.js';

const warningsOf = (items: Awaited<ReturnType<typeof convert>>['items']) =>
  items.filter((item) => item.status === 'warning').map((item) => item.reason);

describe('inline style parsing', () => {
  it('expands box shorthands with CSS 1-4 value semantics', () => {
    expect(expandShorthand('padding', '10px')).toEqual([
      { property: 'padding-top', value: '10px', shorthand: 'padding' },
      { property: 'padding-right', value: '10px', shorthand: 'padding' },
      { property: 'padding-bottom', value: '10px', shorthand: 'padding' },
      { property: 'padding-left', value: '10px', shorthand: 'padding' },
    ]);

    expect(expandShorthand('margin', '1px 2px 3px').map((d) => d.value)).toEqual(['1px', '2px', '3px', '2px']);
    expect(expandShorthand('margin', '1px 2px 3px 4px').map((d) => d.value)).toEqual(['1px', '2px', '3px', '4px']);
  });

  it('expands box shorthands across tabs and newlines, not just spaces', () => {
    // Generated HTML wraps long style attributes; folding these into one value would write a
    // bogus "10px\n20px" onto all four sides.
    expect(expandShorthand('padding', '10px\n20px').map((d) => d.value)).toEqual([
      '10px',
      '20px',
      '10px',
      '20px',
    ]);
    expect(expandShorthand('margin', '1px\t2px').map((d) => d.value)).toEqual(['1px', '2px', '1px', '2px']);
  });

  it('does not split inside url(), quotes, or parens', () => {
    const { declarations } = parseInlineStyle(
      `background-image:url(data:image/svg+xml;base64,AA==);font-family:"Helvetica Neue", serif;width:calc(100% - 2px)`,
    );

    expect(declarations).toEqual([
      { property: 'background-image', value: 'url(data:image/svg+xml;base64,AA==)' },
      { property: 'font-family', value: '"Helvetica Neue", serif' },
      { property: 'width', value: 'calc(100% - 2px)' },
    ]);
  });

  it('honours backslash-escaped quotes', () => {
    const { declarations, problems } = parseInlineStyle(String.raw`font-family:"He\"llo;World", serif;color:red`);

    expect(problems).toEqual([]);
    expect(declarations).toEqual([
      { property: 'font-family', value: String.raw`"He\"llo;World", serif` },
      { property: 'color', value: 'red' },
    ]);
  });

  it('reports malformed chunks instead of dropping them silently', () => {
    const { declarations, problems } = parseInlineStyle('color:red;;nonsense;padding:');

    expect(declarations).toEqual([{ property: 'color', value: 'red' }]);
    expect(problems).toEqual(['nonsense', 'padding:']);
  });

  it('gives !important precedence over a later plain declaration', () => {
    expect(parseInlineStyle('color:red !important;color:blue').declarations).toEqual([
      { property: 'color', value: 'red', important: true },
    ]);
    // Two importants, or two plains — last wins either way.
    expect(parseInlineStyle('color:red !important;color:blue !important').declarations).toEqual([
      { property: 'color', value: 'blue', important: true },
    ]);
    expect(parseInlineStyle('color:red;color:blue').declarations).toEqual([
      { property: 'color', value: 'blue' },
    ]);
  });

  it('accounts for every overridden declaration, naming what beat it', () => {
    // Losing to the author's own declaration is not degradation by us, but it still owes an
    // outcome — it surfaces under --explain, not as a warning.
    expect(parseInlineStyle('color:red;color:blue').overridden).toEqual([
      { property: 'color', value: 'red', by: 'later' },
    ]);
    // Here the LOSER is the later declaration, beaten by the earlier !important — the reason must
    // not claim it was overridden by something later.
    expect(parseInlineStyle('color:red !important;color:blue').overridden).toEqual([
      { property: 'color', value: 'blue', by: 'important' },
    ]);
  });

  it('strips CSS comments, which are valid in a style attribute', () => {
    const { declarations, problems } = parseInlineStyle('color:red;/* note */padding:8px');

    expect(problems).toEqual([]);
    expect(declarations.map((d) => d.property)).toEqual([
      'color',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
    ]);
  });

  it('does not treat a comment inside a quoted string as a comment', () => {
    const { declarations } = parseInlineStyle(`font-family:"a/*b*/c";color:red`);

    expect(declarations).toEqual([
      { property: 'font-family', value: '"a/*b*/c"' },
      { property: 'color', value: 'red' },
    ]);
  });

  it('reports an unterminated comment that swallowed the rest', () => {
    const { declarations, problems } = parseInlineStyle('color:red;/* oops padding:8px');

    expect(declarations).toEqual([{ property: 'color', value: 'red' }]);
    expect(problems).toEqual([expect.stringContaining('unterminated')]);
  });

  it('lets a later shorthand reset the longhands it covers', () => {
    // Keeping the stale 48px here would emit a value the author's own later shorthand reset.
    const font = parseInlineStyle('font-size:48px;font:16px serif');
    expect(font.declarations).toEqual([{ property: 'font', value: '16px serif' }]);
    expect(font.overridden).toEqual([{ property: 'font-size', value: '48px', by: 'later' }]);

    const background = parseInlineStyle('background-image:url(a.jpg);background:#fff');
    expect(background.declarations).toEqual([{ property: 'background', value: '#fff' }]);
    expect(background.overridden).toEqual([
      { property: 'background-image', value: 'url(a.jpg)', by: 'later' },
    ]);

    // `border` resets width/style/color but NOT radius.
    const border = parseInlineStyle('border-radius:8px;border:1px solid red');
    expect(border.declarations.map((d) => d.property).sort()).toEqual(['border', 'border-radius']);
  });

  it('returns surviving declarations in source order', () => {
    // Load-bearing, and fragile: it holds only because applyPrecedence deletes an overridden entry
    // before re-setting it, which moves it to the end of the Map. A refactor to a plain .set()
    // would keep every test above green while silently breaking getInlineBackgroundUrl, which reads
    // the LAST background declaration to decide the cover image.
    expect(parseInlineStyle('color:red;padding:1px;color:blue').declarations.map((d) => d.property)).toEqual([
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'color',
    ]);
  });

  it('lets `all` reset everything before it', () => {
    expect(parseInlineStyle('color:red;padding:8px;all:unset').declarations).toEqual([
      { property: 'all', value: 'unset' },
    ]);
  });

  it('does not let a later shorthand beat an earlier !important longhand', () => {
    // The shorthand still wins for its own property — it just cannot reset the !important
    // longhand, which is what CSS does: `font` sets family/weight, `font-size` stays 48px.
    expect(parseInlineStyle('font-size:48px !important;font:16px serif').declarations).toEqual([
      { property: 'font-size', value: '48px', important: true },
      { property: 'font', value: '16px serif' },
    ]);
  });

  it('lets an earlier !important shorthand protect the longhands it covers', () => {
    // The check has to run in both directions: `font ... !important` protects `font-size`, even
    // though the winner is keyed under a different property name.
    expect(parseInlineStyle('font:16px serif !important;font-size:48px').declarations).toEqual([
      { property: 'font', value: '16px serif', important: true },
    ]);
  });

  it('resets per property, not all-or-nothing', () => {
    // The !important longhand survives the later shorthand; its plain sibling does not.
    const parsed = parseInlineStyle('font-size:48px !important;font-weight:700;font:16px serif');

    expect(parsed.declarations).toEqual([
      { property: 'font-size', value: '48px', important: true },
      { property: 'font', value: '16px serif' },
    ]);
    expect(parsed.overridden).toEqual([{ property: 'font-weight', value: '700', by: 'later' }]);
  });

  it('treats a redundant semicolon as nothing, not as a problem', () => {
    // Valid CSS carrying no declaration and no author intent — warning on it would only train the
    // reader to skim the report.
    const { declarations, problems } = parseInlineStyle('color:red;;padding:8px');
    expect(problems).toEqual([]);
    expect(declarations.map((d) => d.property)).toContain('color');
  });

  it('leaves shorthands it cannot honestly expand whole', () => {
    expect(expandShorthand('border', '1px solid red')).toEqual([
      { property: 'border', value: '1px solid red' },
    ]);
  });
});

describe('supports querying', () => {
  it('honours per-side arrays', () => {
    const supports = { spacing: { margin: ['top', 'bottom'], padding: true } };
    expect(querySupports(supports, { feature: 'spacing', key: 'margin', side: 'top' })).toBe(true);
    expect(querySupports(supports, { feature: 'spacing', key: 'margin', side: 'left' })).toBe(false);
    expect(querySupports(supports, { feature: 'spacing', key: 'padding', side: 'left' })).toBe(true);
  });

  it('treats colour text/background as on unless explicitly false', () => {
    expect(querySupports({ color: {} }, { feature: 'color', key: 'text' })).toBe(true);
    expect(querySupports({ color: { text: false } }, { feature: 'color', key: 'text' })).toBe(false);
    expect(querySupports({ color: true }, { feature: 'color', key: 'background' })).toBe(true);
    expect(querySupports({}, { feature: 'color', key: 'background' })).toBe(false);
  });

  it('resolves __experimental aliases', () => {
    expect(
      querySupports({ typography: { __experimentalLetterSpacing: true } }, {
        feature: 'typography',
        key: 'letterSpacing',
      }),
    ).toBe(true);
    expect(
      querySupports({ __experimentalBorder: { radius: true } }, { feature: 'border', key: 'radius' }),
    ).toBe(true);
  });

  it('honours feature-level booleans', () => {
    expect(querySupports({ typography: true }, { feature: 'typography', key: 'fontSize' })).toBe(true);
    expect(querySupports({ border: true }, { feature: 'border', key: 'radius' })).toBe(true);
    expect(querySupports({ dimensions: true }, { feature: 'dimensions', key: 'minWidth' })).toBe(true);
    expect(querySupports({ spacing: true }, { feature: 'spacing', key: 'margin', side: 'left' })).toBe(true);
    expect(querySupports({ typography: false }, { feature: 'typography', key: 'fontSize' })).toBe(false);
  });

  it('treats gradients as opt-in, unlike text and background', () => {
    expect(querySupports({ color: {} }, { feature: 'gradient' })).toBe(false);
    expect(querySupports({ color: { gradients: true } }, { feature: 'gradient' })).toBe(true);
    expect(querySupports({ color: true }, { feature: 'gradient' })).toBe(true);
  });
});

describe('styling — relaxed (default)', () => {
  it('carries inline CSS onto the block it was authored on', async () => {
    const report = await convert(
      `<div style="padding:64px;background:#f5f5f5"><h2 style="font-size:48px">Hello</h2></div>`,
      { sourcePath: 'hero.html' },
    );

    expect(report.ok).toBe(true);
    expect(report.output).toContain('"padding":{"top":"64px","right":"64px","bottom":"64px","left":"64px"}');
    expect(report.output).toContain('"background":"#f5f5f5"');
    expect(report.output).toContain('"fontSize":"48px"');
    // The value must reach the rendered markup, not just the block comment.
    expect(report.output).toContain('padding-top:64px');
    expect(report.output).toContain('font-size:48px');
  });

  it('gates on block supports and names the block that refused', async () => {
    const report = await convert(`<p style="min-width:100px">Text</p>`);

    expect(report.output).not.toContain('minWidth');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('core/paragraph does not support dimensions.minWidth'),
    );
  });

  it('maps WordPress 7.1 minWidth on a block that opted in', async () => {
    const report = await convert(`<div style="min-width:220px">Text</div>`);

    expect(report.output).toContain('"dimensions":{"minWidth":"220px"}');
    expect(report.output).toContain('min-width:220px');
  });

  it('respects per-side spacing supports', async () => {
    const report = await convert(`<div style="margin-top:10px;margin-left:40px">Text</div>`);

    expect(report.output).toContain('"margin":{"top":"10px"}');
    expect(report.output).not.toContain('margin-left');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('core/group does not support spacing.margin.left'),
    );
  });

  it('refuses text-shadow and points at theme.json', async () => {
    const report = await convert(`<div style="text-shadow:1px 1px 2px #000">Text</div>`);

    expect(report.output).not.toContain('textShadow');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('set theme.json styles.typography.textShadow'),
    );
  });

  it('maps text-align via style.typography, which serialises as a class', async () => {
    // It lands under style.typography.textAlign, NOT as a top-level `textAlign` attribute — core
    // blocks do not declare that, so createBlock strips it and the output would be a silent no-op.
    const report = await convert(`<h2 style="text-align:center">Hi</h2>`);

    expect(report.output).toContain('"textAlign":"center"');
    expect(report.output).toContain('has-text-align-center');
    expect(report.ok).toBe(true);
  });

  it('gates text-align on the block declaring the support', async () => {
    const report = await convert(`<div style="text-align:center"><p>x</p></div>`);

    expect(report.output).not.toContain('textAlign');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('core/group does not support typography.textAlign'),
    );
  });

  it('warns with a source location pointing at the input', async () => {
    const report = await convert(`<div style="max-width:600px">Text</div>`, { sourcePath: 'hero.html' });

    const warning = report.items.find((item) => item.reason.includes('max-width'));
    expect(warning?.source?.path).toBe('hero.html');
    expect(warning?.source?.htmlLine).toBe(1);
    expect(warning?.rule).toBe('styles');
  });

  it('stays silent only where the emitted block genuinely consumed the declaration', async () => {
    // A background image that became cover media is consumed — warning about it would be noise.
    const cover = await convert(`<div style="background-image:url(a.jpg)"><p>x</p><p>y</p></div>`, {
      config: { media: { resolver: 'map', map: { 'a.jpg': { id: 7, url: 'https://e.test/a.jpg' } } } },
    });

    expect(cover.output).toContain('wp:cover');
    expect(warningsOf(cover.items).join('\n')).not.toContain('background-image');
  });

  it('reports a background image that did not become media, rather than assuming it was consumed', async () => {
    const report = await convert(`<p style="background-image:url(a.jpg)">Text</p>`);

    expect(report.output).not.toContain('a.jpg');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('not the media this block carries'),
    );
  });

  it('proves consumption from the rule, not from the block name or the URL', async () => {
    // core/image carries x.jpg and the rule read `src`, never the declaration.
    const mismatched = await convert(`<img src="x.jpg" style="background-image:url(y.jpg)" alt="a">`);
    expect(mismatched.output).toContain('wp:image');
    expect(warningsOf(mismatched.items)).toContainEqual(expect.stringContaining('url(y.jpg)'));

    // The hard case: the URLs coincide. The rule still read `src`, not the declaration, so URL
    // equality would wrongly call this consumed.
    const coincidental = await convert(`<img src="a.jpg" style="background-image:url(a.jpg)" alt="a">`);
    expect(coincidental.output).toContain('wp:image');
    expect(warningsOf(coincidental.items)).toContainEqual(
      expect.stringContaining('not the media this block carries'),
    );
  });

  it('reports that a mapped !important lost its priority', async () => {
    // The value lands but its cascade priority cannot — WordPress writes block styles as plain
    // declarations, so calling this a clean success would overstate it.
    const report = await convert(`<div style="color:red !important">Text</div>`);

    expect(report.output).toContain('"text":"red"');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('without its !important priority'),
    );
  });

  it('does not treat a non-url background-image as consumed, even on a media-bearing block', async () => {
    // The structural rules find backgrounds by matching url(), so a gradient is never read by
    // them — claiming it as consumed would lose it silently.
    const report = await convert(
      `<div style="background-image:linear-gradient(red,blue)"><p>x</p><p>y</p></div>`,
    );

    expect(warningsOf(report.items)).toContainEqual(expect.stringContaining('background-image'));
  });

  it('reports the components of a composite background that did not survive', async () => {
    const report = await convert(`<div style="background:red url(a.jpg) center/cover"><p>x</p><p>y</p></div>`, {
      config: { media: { resolver: 'map', map: { 'a.jpg': { id: 7, url: 'https://e.test/a.jpg' } } } },
    });

    expect(report.output).toContain('wp:cover');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('only the url() became block media'),
    );
  });

  it('picks the background image CSS actually resolves to', async () => {
    // The structural rules and the ledger must read the attribute the same way. A regex scan takes
    // the first url() it sees, which builds a Cover from an image CSS already replaced or removed.
    // Both `background` and `background-image` can survive precedence — a longhand does not reset
    // the shorthand — so the one declared LAST owns the image component.
    const cases: Array<[string, string | undefined]> = [
      ['background:url(a.jpg);background-image:url(b.jpg)', 'b.jpg'],
      ['background-image:url(a.jpg);background:url(b.jpg)', 'b.jpg'],
      ['background:#fff;background-image:url(a.jpg)', 'a.jpg'],
      // Importance outranks source order.
      ['background-image:url(a.jpg) !important;background:url(b.jpg)', 'a.jpg'],
      ['background:url(a.jpg) !important;background-image:url(b.jpg)', 'a.jpg'],
      // Later declaration removes the image entirely.
      ['background:url(a.jpg);background-image:none', undefined],
      ['background-image:url(a.jpg);background:#fff', undefined],
    ];

    for (const [style, expected] of cases) {
      const report = await convert(`<div style="${style}"><p>x</p><p>y</p></div>`, {
        config: {
          media: {
            resolver: 'map',
            map: {
              'a.jpg': { id: 1, url: 'https://e.test/a.jpg' },
              'b.jpg': { id: 2, url: 'https://e.test/b.jpg' },
            },
          },
        },
      });

      if (expected) {
        expect(report.output, style).toContain(`wp:cover {"url":"https://e.test/${expected}"`);
      } else {
        expect(report.output, style).not.toContain('wp:cover');
      }
    }
  });

  it('uses the winning background declaration and does not report the overridden one as a loss', async () => {
    // `background` resets `background-image`, so b.jpg is the live declaration and becomes the
    // media. a.jpg is `overridden` — beaten by the author's own later declaration — so it must not
    // be reported as something we dropped.
    const report = await convert(
      `<div style="background-image:url(a.jpg);background:url(b.jpg)"><p>x</p><p>y</p></div>`,
      { config: { media: { resolver: 'map', map: { 'b.jpg': { id: 9, url: 'https://e.test/b.jpg' } } } } },
    );

    expect(report.output).toContain('https://e.test/b.jpg');
    const warnings = warningsOf(report.items).join('\n');
    expect(warnings).not.toContain('url(a.jpg)');
    expect(warnings).not.toContain('url(b.jpg)');
  });

  it('stays silent for a url-only background that became media', async () => {
    const report = await convert(`<div style="background-image:url(a.jpg)"><p>x</p><p>y</p></div>`, {
      config: { media: { resolver: 'map', map: { 'a.jpg': { id: 7, url: 'https://e.test/a.jpg' } } } },
    });

    expect(report.output).toContain('wp:cover');
    expect(warningsOf(report.items).join('\n')).not.toContain('background');
  });

  it('reports layout properties no rule reads', async () => {
    // Nothing in the converter reads display/gap today, so claiming them as "consumed" would be
    // silent loss dressed up as success.
    const report = await convert(`<p style="gap:16px;display:flex">Text</p>`);

    const warnings = warningsOf(report.items).join('\n');
    expect(warnings).toContain('gap');
    expect(warnings).toContain('display');
  });

  it('reports unparseable declarations', async () => {
    const report = await convert(`<div style="color:red;;nonsense;padding:">Text</div>`);

    expect(report.output).toContain('"text":"red"');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('"nonsense" dropped — not a parseable CSS declaration'),
    );
  });

  it('routes the background shorthand by value', async () => {
    const gradient = await convert(`<div style="background:linear-gradient(red,blue)">Text</div>`);
    expect(gradient.output).toContain('"gradient":"linear-gradient(red,blue)"');

    const colour = await convert(`<div style="background:#f5f5f5">Text</div>`);
    expect(colour.output).toContain('"background":"#f5f5f5"');

    // `none` is valid CSS but expresses no colour a block control can hold.
    const none = await convert(`<div style="background:none">Text</div>`);
    expect(none.output).not.toContain('"background"');
    expect(warningsOf(none.items)).toContainEqual(
      expect.stringContaining('multi-component background shorthand'),
    );
  });

  it('gates gradients on the gradients support, which is opt-in', async () => {
    // core/paragraph enables gradients; a block without the support must refuse.
    const report = await convert(`<p style="background:linear-gradient(red,blue)">Text</p>`);

    expect(report.output).toContain('"gradient"');
  });

  it('does not double-apply styles onto a Custom HTML fallback', async () => {
    const report = await convert(`<svg style="padding:8px"><circle r="1" /></svg>`);

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('"padding"');
    expect(warningsOf(report.items).join('\n')).not.toContain('padding');
  });
});

describe('styling — unattributable CSS', () => {
  // A rule that fans one element out into several blocks leaves no honest home for its CSS. The
  // default rules always wrap, so this is reached through a custom rule — a public extension point.
  const splittingRule = {
    id: 'test-split',
    match: (node: Element) => node.tagName.toLowerCase() === 'div' && node.classList.contains('split'),
    emit: async (node: Element, context: RuleContext) => [
      context.wp.createBlock('core/paragraph', { content: 'one' }, []),
      context.wp.createBlock('core/paragraph', { content: 'two' }, []),
    ],
  };

  it('reports one outcome per declaration, not a single aggregate note', async () => {
    const report = await convert(`<div class="split" style="padding:8px;color:red;max-width:9px">x</div>`, {
      config: { rules: { custom: [splittingRule] } },
    });

    const warnings = warningsOf(report.items);
    expect(warnings).toContainEqual(expect.stringContaining('padding (padding-top): 8px'));
    expect(warnings).toContainEqual(expect.stringContaining('color: red'));
    expect(warnings).toContainEqual(expect.stringContaining('max-width: 9px'));
    expect(warnings.every((reason) => !/inline styles dropped/.test(reason))).toBe(true);
    // Every warning names why there is no home for it.
    expect(warnings.filter((r) => /no single home/.test(r)).length).toBeGreaterThanOrEqual(4);
  });
});

describe('styling — nodes that bypass the walker', () => {
  // These are all built directly by a rule rather than routed through walkNode, so the walker's
  // styling hook never sees them. Each one silently swallowed its CSS before this was wired up —
  // on the cover > columns > buttons path, which is the converter's primary shape.
  const explainOf = (items: Awaited<ReturnType<typeof convert>>['items']) =>
    items.filter((item) => (item.details as { explainOnly?: boolean } | undefined)?.explainOnly);

  it('accounts for column-cell CSS', async () => {
    const report = await convert(
      `<div class="row"><div class="col" style="padding:64px;margin-top:8px"><p>a</p></div><div class="col"><p>b</p></div></div>`,
    );

    expect(report.output).toContain('wp:column {"style"');
    expect(report.output).toContain('"padding":{"top":"64px"');
    // core/column supports padding and blockGap, not margin — so this is reported, not swallowed.
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('core/column does not support spacing.margin.top'),
    );
  });

  it('accounts for button-anchor CSS', async () => {
    const report = await convert(`<div class="buttons"><a class="btn" href="/x" style="color:red;padding:8px">Go</a></div>`);

    expect(report.output).toContain('wp:button {"style"');
    expect(report.output).toContain('"text":"red"');
    // core/button padding is axial (horizontal/vertical), so per-side values are reported.
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('core/button does not support spacing.padding.top'),
    );
  });

  it('accounts for CSS on rich-text descendants', async () => {
    const relaxed = await convert(`<p>hello <span style="color:red">world</span></p>`, { explain: true });

    // Under relaxed the CSS genuinely survives inline, so it is consumed rather than dropped — but
    // it is accounted for, not invisible.
    expect(relaxed.output).toContain('<span style="color:red">');
    expect(explainOf(relaxed.items).map((item) => item.reason)).toContainEqual(
      expect.stringContaining('carried inline on <span> inside rich text'),
    );
  });

  it('strips rich-text descendant CSS under strict, which promises on-system output only', async () => {
    const strict = await convert(`<p>hello <span style="color:red">world</span></p>`, { styling: 'strict' });

    expect(strict.output).not.toContain('style="color:red"');
    expect(strict.output).toContain('<span>world</span>');
    expect(warningsOf(strict.items)).toContainEqual(
      expect.stringContaining('stripped from <span> inside rich text'),
    );
  });
});

describe('styling — <style> class rules', () => {
  it('maps declarations from a single-class rule', async () => {
    const report = await convert(`<style>.hero{padding:64px;background:#f5f5f5}</style><div class="hero"><p>x</p></div>`);

    expect(report.output).toContain('"padding":{"top":"64px"');
    expect(report.output).toContain('"background":"#f5f5f5"');
  });

  it('lets an inline style outrank a class rule', async () => {
    const report = await convert(`<style>.hero{padding:64px}</style><div class="hero" style="padding:8px"><p>x</p></div>`);

    expect(report.output).toContain('"top":"8px"');
    expect(report.output).not.toContain('64px');
  });

  it('lets a later class rule win at equal specificity', async () => {
    const report = await convert(`<style>.a{color:red}.b{color:blue}</style><div class="a b"><p>x</p></div>`);

    expect(report.output).toContain('"text":"blue"');
  });

  it('names the rule a dropped declaration came from', async () => {
    const report = await convert(`<style>.hero{max-width:600px}</style><div class="hero"><p>x</p></div>`);

    expect(warningsOf(report.items)).toContainEqual(expect.stringContaining('max-width: 600px in .hero'));
  });

  it('ignores selectors that are not a single class', async () => {
    const report = await convert(
      `<style>div.hero p{color:red}.hero:hover{color:green}</style><div class="hero"><p>x</p></div>`,
    );

    expect(report.output).not.toContain('"text":"red"');
    expect(report.output).not.toContain('"text":"green"');
  });

  it('does not apply rules nested inside an at-rule', async () => {
    // A flat rule scan happily matches `.hero` inside `@media print`, which would style every render
    // with CSS meant for one. At-rule blocks are dropped whole.
    const report = await convert(
      `<style>@media print{.hero{color:pink}}@supports (display:grid){.hero{color:teal}}</style><div class="hero"><p>x</p></div>`,
    );

    expect(report.output).not.toContain('pink');
    expect(report.output).not.toContain('teal');
  });

  it('resolves the background across sources as one cascade', async () => {
    // Resolving inline and class rules separately meant an inline reset returned "no image", which
    // then fell through to the class rule and built a Cover from an image the author removed.
    const reset = await convert(
      `<style>.hero{background:url(a.jpg)}</style><div class="hero" style="background-image:none"><p>x</p><p>y</p></div>`,
    );
    expect(reset.output).not.toContain('wp:cover');

    // And between two classes it must follow stylesheet order, not classList order.
    const ordered = await convert(
      `<style>.b{background-image:url(b.jpg)}.a{background-image:url(a.jpg)}</style><div class="a b"><p>x</p><p>y</p></div>`,
    );
    expect(ordered.output).toContain('"url":"a.jpg"');
  });

  it('treats a class-sourced background as consumed, so open does not re-emit it', async () => {
    // Otherwise the image is applied twice: once as Cover media, once via sidecar CSS.
    const report = await convert(
      `<style>.hero{background-image:url(a.jpg)}</style><div class="hero"><p>x</p><p>y</p></div>`,
      { styling: 'open' },
    );

    expect(report.output).toContain('wp:cover');
    expect(report.sidecarCss).toBeUndefined();
  });

  it('resolves the cascade across every rule for a class', async () => {
    // A later rule saying nothing about background-image must not clear one set earlier.
    const report = await convert(
      `<style>.hero{background-image:url(a.jpg)}.hero{color:red}</style><div class="hero"><p>x</p><p>y</p></div>`,
    );

    expect(report.output).toContain('wp:cover');
    expect(report.output).toContain('a.jpg');
    expect(report.output).toContain('"text":"red"');
  });

  it('applies background precedence to class rules too', async () => {
    // The same S12 rule as inline styles: a later shorthand removes an earlier image.
    const report = await convert(
      `<style>.hero{background-image:url(a.jpg);background:#fff}</style><div class="hero"><p>x</p><p>y</p></div>`,
    );

    expect(report.output).not.toContain('wp:cover');
    expect(report.output).toContain('"background":"#fff"');
  });

  it('reports class-authored CSS on rich-text descendants as lost', async () => {
    // Unlike an inline style on a descendant, this genuinely does not survive: the class rides into
    // the content but the stylesheet it pointed at is stripped.
    const report = await convert(`<style>.hl{color:red}</style><p>hi <span class="hl">x</span></p>`);

    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('the class survives but its stylesheet does not'),
    );
  });
});

describe('styling — open', () => {
  it('carries unmappable CSS into sidecar CSS on a generated class', async () => {
    const report = await convert(`<div style="max-width:600px;padding:8px"><p>x</p></div>`, { styling: 'open' });

    // Still maps what it can natively; only the remainder goes to the sidecar.
    expect(report.output).toContain('"padding":{"top":"8px"');
    expect(report.sidecarCss).toContain('max-width:600px');
    const className = /\.(br-[0-9a-f]+)/.exec(report.sidecarCss!)![1];
    expect(report.output).toContain(className);
    expect(warningsOf(report.items).join('\n')).not.toContain('max-width');
  });

  it('rescues what lower rungs refuse', async () => {
    // text-shadow has no per-instance control, which is why relaxed refuses it — but `open` is the
    // explicit escape hatch for exactly that, and the caller has opted into shipping CSS.
    const open = await convert(`<div style="text-shadow:1px 1px 2px #000"><p>x</p></div>`, { styling: 'open' });
    expect(open.sidecarCss).toContain('text-shadow');

    const relaxed = await convert(`<div style="text-shadow:1px 1px 2px #000"><p>x</p></div>`);
    expect(relaxed.sidecarCss).toBeUndefined();
    expect(warningsOf(relaxed.items)).toContainEqual(expect.stringContaining('theme.json'));
  });

  it('keeps the author selector for class-authored rules, and puts that class on the block', async () => {
    const report = await convert(`<style>.hero{max-width:600px}</style><div class="hero"><p>x</p></div>`, {
      styling: 'open',
    });

    expect(report.sidecarCss).toContain('.hero {');
    // The converter drops input classes, so without re-attaching it the rule would select nothing.
    expect(report.output).toContain('"className":"hero"');
  });

  it('preserves !important in rescued CSS, and does not collide with its plain twin', async () => {
    // A sidecar rule competes with the theme's stylesheet, so dropping the priority changes which
    // rule wins — and dropping it while reporting the declaration as rescued is a silent loss.
    const important = await convert(`<div style="max-width:600px !important"><p>x</p></div>`, { styling: 'open' });
    expect(important.sidecarCss).toContain('max-width:600px !important');

    const plain = await convert(`<div style="max-width:600px"><p>x</p></div>`, { styling: 'open' });
    expect(plain.sidecarCss).toContain('max-width:600px');
    expect(plain.sidecarCss).not.toContain('!important');
    // Different rules must not hash to the same class.
    expect(important.sidecarCss).not.toBe(plain.sidecarCss);
  });

  it('preserves declaration order, which is cascade-significant', async () => {
    // Sorting for determinism would put the reset first and restore the image the author removed.
    const report = await convert(`<div style="background:url(a.jpg);background-image:none"><p>x</p></div>`, {
      styling: 'open',
    });

    expect(report.sidecarCss).toContain('background:url(a.jpg); background-image:none');
  });

  it('preserves values containing semicolons', async () => {
    // Round-tripping through a joined string and splitting on ';' corrupts data URLs and quoted
    // stacks — which would break the exact preservation `open` exists to provide.
    const dataUrl = await convert(`<p style="background-image:url(data:image/svg+xml;base64,AA==)">x</p>`, {
      styling: 'open',
    });
    expect(dataUrl.sidecarCss).toContain('url(data:image/svg+xml;base64,AA==)');

    const quoted = await convert(`<p style="font:12px 'A;B', serif">x</p>`, { styling: 'open' });
    expect(quoted.sidecarCss).toContain(`font:12px 'A;B', serif`);
  });

  it('emits sidecar rules in stylesheet order, not alphabetical', async () => {
    // Sorting selectors can reverse authored order and flip which declaration wins for an element
    // carrying several classes. The two rules must set DIFFERENT properties: with the same property
    // the later rule wins the cascade outright, `.zeta` never reaches the sidecar, and an indexOf
    // of -1 would satisfy the assertion without proving anything.
    const report = await convert(
      `<style>.zeta{overflow:hidden}.alpha{max-width:2px}</style><div class="zeta alpha"><p>x</p></div>`,
      { styling: 'open' },
    );

    const css = report.sidecarCss!;
    expect(css).toContain('.zeta');
    expect(css).toContain('.alpha');
    expect(css.indexOf('.zeta')).toBeLessThan(css.indexOf('.alpha'));
  });

  it('does not re-emit a compound background after its image becomes media', async () => {
    // Re-emitting the shorthand would apply the same image twice: once as Cover media and once in
    // the sidecar stylesheet.
    const report = await convert(`<div style="background:red url(a.jpg) center/cover"><p>x</p><p>y</p></div>`, {
      styling: 'open',
      config: { media: { resolver: 'map', map: { 'a.jpg': { id: 7, url: 'https://e.test/a.jpg' } } } },
    });

    expect(report.output).toContain('wp:cover');
    expect(report.sidecarCss ?? '').not.toContain('a.jpg');
    expect(warningsOf(report.items)).toContainEqual(expect.stringContaining('only the url() became block media'));
  });

  it('keeps a repeated selector as separate rules in their authored positions', async () => {
    // `.hero` appears twice, straddling `.other`. Merging both occurrences onto the first would emit
    // `float:left` before `.other`, reversing the author's cascade.
    const report = await convert(
      `<style>.hero{overflow:hidden}.other{max-width:9px}.hero{float:left}</style><div class="hero other"><p>x</p></div>`,
      { styling: 'open' },
    );

    expect(report.sidecarCss).toBe(
      '.hero { overflow:hidden }\n.other { max-width:9px }\n.hero { float:left }\n',
    );
  });

  it('orders sidecar rules by stylesheet position across DOM encounters', async () => {
    // The first DOM element can introduce a selector after another selector already appeared in the
    // stylesheet, so CSS order must follow the stylesheet rather than collector insertion order.
    const report = await convert(
      `<style>.zeta{overflow:hidden}.alpha{max-width:2px}</style><div class="alpha"><p>a</p></div><div class="zeta alpha"><p>b</p></div>`,
      { styling: 'open' },
    );

    const css = report.sidecarCss!;
    expect(css).toContain('.zeta');
    expect(css.indexOf('.zeta')).toBeLessThan(css.indexOf('.alpha'));
    // `.alpha` is carried by two elements; appending per element would emit its declaration twice.
    expect(css.match(/max-width:2px/g)).toHaveLength(1);
  });

  it('is deterministic and shares one class across identical declarations', async () => {
    const html = `<div style="max-width:600px"><p>a</p></div><div style="max-width:600px"><p>b</p></div>`;
    const first = await convert(html, { styling: 'open' });
    const second = await convert(html, { styling: 'open' });

    expect(first.sidecarCss).toBe(second.sidecarCss);
    expect(first.sidecarCss!.match(/br-[0-9a-f]+/g)).toHaveLength(1);
  });

  it('does not claim to carry CSS it cannot attach a class to', async () => {
    const splitting = {
      id: 'test-split-open',
      match: (node: Element) => node.tagName.toLowerCase() === 'div' && node.classList.contains('split'),
      emit: async (node: Element, context: RuleContext) => [
        context.wp.createBlock('core/paragraph', { content: 'one' }, []),
        context.wp.createBlock('core/paragraph', { content: 'two' }, []),
      ],
    };
    const report = await convert(`<div class="split" style="max-width:600px">x</div>`, {
      styling: 'open',
      config: { rules: { custom: [splitting] } },
    });

    expect(report.sidecarCss).toBeUndefined();
    expect(warningsOf(report.items)).toContainEqual(expect.stringContaining('no single home'));
  });
});

describe('styling — strict', () => {
  const config = {
    tokens: {
      colors: { primary: '#333333', base: '#f5f5f5' },
      fontSizes: { large: '48px' },
      spacing: { '50': '64px' },
    },
  };

  it('snaps on-system values to presets', async () => {
    const report = await convert(
      `<div style="padding:64px;background:#f5f5f5"><h2 style="font-size:48px">Hello</h2></div>`,
      { styling: 'strict', config },
    );

    expect(report.output).toContain('"backgroundColor":"base"');
    expect(report.output).toContain('var:preset|spacing|50');
    expect(report.output).toContain('"fontSize":"large"');
  });

  it('drops off-system values and logs why', async () => {
    const report = await convert(`<h2 style="letter-spacing:2px">Hello</h2>`, { styling: 'strict', config });

    expect(report.output).not.toContain('letterSpacing');
    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('strict styling keeps only on-system values'),
    );
  });
});

describe('styling — capability source', () => {
  // The whole point of reading a wesper manifest: the same input, on the same pin, degrades
  // according to what the *target site* actually supports — with no WordPress version table.
  const wp70 = 'test/fixtures/site.context.wp70.json';

  it('drops a feature the target site does not support, even though the pin does', async () => {
    const pinned = await convert(`<div style="min-width:220px">Text</div>`);
    expect(pinned.output).toContain('min-width:220px');

    const site = await convert(`<div style="min-width:220px">Text</div>`, { context: wp70 });
    expect(site.output).not.toContain('minWidth');
    expect(warningsOf(site.items)).toContainEqual(
      expect.stringContaining('core/group does not support dimensions.minWidth in the target site'),
    );
  });

  it('still maps what both the pin and the site support', async () => {
    const report = await convert(`<div style="padding:64px">Text</div>`, { context: wp70 });

    expect(report.output).toContain('padding-top:64px');
  });

  it('intersects rather than trusting the site alone', async () => {
    // The fixture grants core/paragraph unrestricted margin; the pin agrees, so it maps. The
    // reverse case (site-only support) is covered by minWidth above.
    const report = await convert(`<p style="margin-left:40px">Text</p>`, { context: wp70 });

    expect(report.output).toContain('margin-left:40px');
  });

  it('says so when the manifest carries no registry to intersect with', async () => {
    const report = await convert(`<div style="padding:8px">Text</div>`, {
      context: 'test/fixtures/site.context.json',
    });

    expect(warningsOf(report.items)).toContainEqual(
      expect.stringContaining('carries no blocks.types registry'),
    );
    // Falling back to the pin must still convert, not refuse everything.
    expect(report.output).toContain('padding-top:8px');
  });

  it('fails rather than widening back to the pin when an explicit context is unreadable', async () => {
    const report = await convert(`<div style="padding:8px">Text</div>`, {
      context: 'test/fixtures/does-not-exist.json',
    });

    expect(report.ok).toBe(false);
    expect(report.items.some((item) => /could not be read as JSON/.test(item.reason))).toBe(true);
  });

  it('fails closed on a blocks key with no usable registry', async () => {
    // Distinct from a theme-only manifest: `blocks` present but unusable is a broken collection,
    // and widening capabilities off the back of it is the wrong failure direction.
    const report = await convert(`<div style="padding:8px">Text</div>`, {
      context: 'test/fixtures/site.context.empty.json',
    });

    expect(report.ok).toBe(false);
    expect(report.items.some((item) => /no usable block registry/.test(item.reason))).toBe(true);
  });
});

describe('styling — rung validation', () => {
  it('rejects a planned-but-unbuilt rung rather than pretending to honour it', async () => {
    // `source` is not in StylingRung — the type deliberately excludes an option every runtime path
    // rejects — so this casts to prove the runtime guard, which config files can still reach.
    const report = await convert(`<div style="padding:8px">Text</div>`, { styling: 'source' as never });

    expect(report.ok).toBe(false);
    expect(report.items.some((item) => /"source" is not implemented yet/.test(item.reason))).toBe(true);
  });

  it('rejects an unknown rung instead of silently using relaxed', async () => {
    const report = await convert(`<div style="padding:8px">Text</div>`, {
      styling: 'bogus' as never,
    });

    expect(report.ok).toBe(false);
    expect(report.items.some((item) => /unknown styling ceiling/.test(item.reason))).toBe(true);
  });
});

describe('token repair — style pruning regression', () => {
  it('prunes only empty branches, leaving populated ones intact', async () => {
    // The recursive prune replaced named color/typography/spacing handling; populated branches
    // must survive, and a branch fully emptied by preset repair must go.
    const report = await convert(
      `<div style="background:#f5f5f5;padding:64px;border-radius:8px"><h2 style="font-size:48px;letter-spacing:2px">Hi</h2></div>`,
      { config: { tokens: { colors: { base: '#f5f5f5' }, fontSizes: { large: '48px' } } } },
    );

    // color.background was repaired to a preset attribute, emptying style.color entirely.
    expect(report.output).toContain('"backgroundColor":"base"');
    expect(report.output).not.toContain('"color":{}');
    // typography kept letterSpacing after fontSize became a preset — the branch must remain.
    expect(report.output).toContain('"fontSize":"large"');
    expect(report.output).toContain('"letterSpacing":"2px"');
    // Untouched branches survive.
    expect(report.output).toContain('"radius":"8px"');
    expect(report.output).toContain('"padding"');
    expect(report.output).not.toContain('"style":{}');
  });
});
