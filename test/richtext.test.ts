import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { richTextSafe } from '../src/convert/richtext.js';

const el = (html: string): Element => new JSDOM(html).window.document.body.firstElementChild!;

describe('richTextSafe', () => {
  it('accepts a paragraph with only phrasing content', () => {
    const check = richTextSafe(el('<p>Text <strong>b</strong> <a href="/x">l</a> <code>c</code> <mark>m</mark> <sub>s</sub> <sup>s</sup></p>'));

    expect(check.safe).toBe(true);
  });

  it('rejects a paragraph containing a foreign SVG element', () => {
    const check = richTextSafe(el('<p><svg><rect/></svg></p>'));

    expect(check.safe).toBe(false);
    if (!check.safe) {
      expect(check.reason).toContain('foreign element');
      expect(check.offender.tagName.toLowerCase()).toBe('svg');
    }
  });

  it('rejects a paragraph containing an img', () => {
    const check = richTextSafe(el('<p><img src="x"></p>'));

    expect(check.safe).toBe(false);
  });

  it('rejects a javascript: URL in an anchor href', () => {
    const check = richTextSafe(el('<p><a href="javascript:alert(1)">x</a></p>'));

    expect(check.safe).toBe(false);
    if (!check.safe) {
      expect(check.reason).toContain('javascript:');
    }
  });

  it('rejects an event handler attribute', () => {
    const check = richTextSafe(el('<p><span onclick="x()">y</span></p>'));

    expect(check.safe).toBe(false);
    if (!check.safe) {
      expect(check.reason).toContain('event handler');
    }
  });

  it('passes through structural list tags without treating them as offenders', () => {
    const check = richTextSafe(el('<ul><li>a<ul><li>b</li></ul></li></ul>'), {
      structural: new Set(['ul', 'ol', 'li']),
    });

    expect(check.safe).toBe(true);
  });
});

describe('richTextSafe allowlist drift canary', () => {
  it('keeps every allowed inline format native through a real Gutenberg round-trip', async () => {
    const html =
      '<p>Text <a href="/x">a</a> <abbr title="t">abbr</abbr> <b>b</b> <bdi>bdi</bdi> <bdo dir="ltr">bdo</bdo> ' +
      '<cite>cite</cite> <code>code</code> <data value="1">data</data> <del>del</del> <dfn>dfn</dfn> <em>em</em> ' +
      '<i>i</i> <ins>ins</ins> <kbd>kbd</kbd> <mark>mark</mark> <q>q</q> <s>s</s> <samp>samp</samp> <small>small</small> ' +
      '<span>span</span> <strong>strong</strong> <sub>sub</sub> <sup>sup</sup> <time>time</time> <u>u</u> <var>var</var>.</p>';

    const report = await convert(html);

    expect(report.summary.invalid).toBe(0);
    expect(report.output).not.toContain('wp:html');
  });
});
