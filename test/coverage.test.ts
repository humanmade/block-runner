import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';

describe('traditional-content coverage', () => {
  it('does not throw on a standalone foreign SVG and falls back to Custom HTML', async () => {
    const report = await convert('<svg viewBox="0 0 4 4"><rect/></svg>');

    expect(report.output).toContain('wp:html');
    expect(report.items.some((item) => item.reason.includes('foreign element'))).toBe(true);
  });

  it('does not throw on standalone MathML and falls back to Custom HTML', async () => {
    const report = await convert('<math><mrow><mi>x</mi></mrow></math>');

    expect(report.output).toContain('wp:html');
    expect(report.items.some((item) => item.reason.includes('foreign element'))).toBe(true);
  });

  it('does not throw on an SVG nested inside columns', async () => {
    const html =
      '<div class="row"><div class="col"><svg viewBox="0 0 4 4"><rect/></svg></div><div class="col"><p>two</p></div></div>';
    const report = await convert(html);

    expect(report.summary.invalid).toBe(0);
  });

  it('falls back a paragraph containing inline SVG to Custom HTML', async () => {
    const report = await convert('<p>Click <svg viewBox="0 0 2 2"><rect/></svg> here</p>');

    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:paragraph');
    const item = report.items.find((entry) => entry.reason.includes('enclosing block emitted as Custom HTML fallback'));
    expect(item).toBeDefined();
    expect(item?.source?.selector).toContain('svg');
  });

  it('falls back a heading containing inline SVG to Custom HTML', async () => {
    const report = await convert('<h2>Icon <svg viewBox="0 0 2 2"><rect/></svg></h2>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:heading');
  });

  it('falls back a button anchor containing inline SVG to Custom HTML', async () => {
    const report = await convert('<a class="btn" href="/go">Buy <svg viewBox="0 0 2 2"><rect/></svg></a>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:button');
  });

  it('falls back a list containing inline SVG to Custom HTML', async () => {
    const report = await convert('<ul><li>ok</li><li>icon <svg viewBox="0 0 2 2"><rect/></svg></li></ul>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:list');
  });

  it('keeps a nested list native when it is RichText-safe', async () => {
    const report = await convert('<ul><li>a<ul><li>nested</li></ul></li><li>b</li></ul>');

    expect(report.output).toContain('wp:list');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).not.toContain('wp:html');
  });

  it('keeps a paragraph with mixed inline formatting native', async () => {
    const report = await convert(
      '<p>Text <strong>b</strong> <em>i</em> <code>c</code> <mark>m</mark> <a href="/x">l</a>.</p>',
    );

    expect(report.output).toContain('wp:paragraph');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).not.toContain('wp:html');
  });

  it('converts a table with colspan and scope to core/table', async () => {
    const report = await convert(
      '<table><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td colspan="2">1</td></tr></tbody></table>',
    );

    expect(report.output).toContain('wp:table');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('colspan="2"');
    expect(report.output).toContain('scope="col"');
  });

  it('falls back a table with block content in a cell to Custom HTML', async () => {
    const report = await convert('<table><tbody><tr><td><p>x</p></td></tr></tbody></table>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:table');
  });

  it('converts a blockquote with a cite to core/quote', async () => {
    const report = await convert('<blockquote><p>Q.</p><cite>Someone</cite></blockquote>');

    expect(report.output).toContain('wp:quote');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('<cite>Someone</cite>');
  });

  it('preserves a code sample byte-for-byte in core/code', async () => {
    const html = String.raw`<pre><code>const x = 1;
if (a &lt; b) {}</code></pre>`;
    const report = await convert(html);

    expect(report.output).toContain('wp:code');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('&lt;');
  });

  it('preserves internal whitespace of a bare pre in core/preformatted', async () => {
    const report = await convert('<pre>plain   spaced   text</pre>');

    expect(report.output).toContain('wp:preformatted');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('plain   spaced   text');
  });

  it('converts an hr to core/separator', async () => {
    const report = await convert('<hr>');

    expect(report.output).toContain('wp:separator');
    expect(report.summary.invalid).toBe(0);
  });

  it('converts a video with a direct src to core/video', async () => {
    const report = await convert('<video src="/m.mp4" controls poster="/p.jpg"></video>');

    expect(report.output).toContain('wp:video');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('src="/m.mp4"');
    expect(report.output).toContain('poster="/p.jpg"');
  });

  it('falls back a video without a direct src to Custom HTML', async () => {
    const report = await convert('<video controls><source src="/m.mp4"></video>');

    expect(report.output).toContain('wp:html');
    expect(report.items.some((item) => item.reason.includes('video without a direct src'))).toBe(true);
  });

  it('converts an audio with a direct src to core/audio', async () => {
    const report = await convert('<audio src="/s.mp3" controls></audio>');

    expect(report.output).toContain('wp:audio');
    expect(report.summary.invalid).toBe(0);
  });

  it('converts an open details to core/details with showContent true', async () => {
    const report = await convert('<details open><summary>More</summary><p>hidden</p></details>');

    expect(report.output).toContain('wp:details');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('"showContent":true');
  });

  it('converts a closed details to core/details without showContent', async () => {
    const report = await convert('<details><summary>S</summary><p>c</p></details>');

    expect(report.output).toContain('wp:details');
    expect(report.output).not.toContain('"showContent":true');
  });

  it('converts a YouTube iframe to core/embed', async () => {
    const report = await convert('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>');

    expect(report.output).toContain('wp:embed');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('"providerNameSlug":"youtube"');
    expect(report.output).toContain('watch?v=dQw4w9WgXcQ');
  });

  it('converts a Vimeo iframe to core/embed', async () => {
    const report = await convert('<iframe src="https://player.vimeo.com/video/76979871"></iframe>');

    expect(report.output).toContain('wp:embed');
    expect(report.output).toContain('"providerNameSlug":"vimeo"');
  });

  it('falls back an iframe with an unknown provider to Custom HTML', async () => {
    const report = await convert('<iframe src="https://example.com/x"></iframe>');

    expect(report.output).toContain('wp:html');
    expect(report.items.some((item) => item.reason.includes('unsupported iframe'))).toBe(true);
  });

  it('falls back a definition list to Custom HTML with no native block reason', async () => {
    const report = await convert('<dl><dt>T</dt><dd>D</dd></dl>');

    expect(report.output).toContain('wp:html');
    expect(report.items.some((item) => item.reason.includes('no native block'))).toBe(true);
  });

  it('dispatches a figure with video content to core/video, keeping the caption', async () => {
    const report = await convert('<figure><video src="/m.mp4" controls></video><figcaption>Clip</figcaption></figure>');

    expect(report.output).toContain('wp:video');
    expect(report.output).toMatch(/<figcaption[^>]*>[^<]*Clip/);
  });

  it('dispatches a figure with table content to core/table', async () => {
    const report = await convert('<figure><table><tbody><tr><td>1</td></tr></tbody></table><figcaption>Cap</figcaption></figure>');

    expect(report.output).toContain('wp:table');
    expect(report.summary.invalid).toBe(0);
  });

  it('marks the report not-ok under strict mode when only a fallback warning occurred', async () => {
    const report = await convert('<dl><dt>T</dt><dd>D</dd></dl>', { strict: true });

    expect(report.ok).toBe(false);
    expect(report.summary.invalid).toBe(0);
  });

  it('contains a throwing custom rule to that node instead of aborting the run', async () => {
    const report = await convert('<p>hi</p><div class="x">y</div>', {
      config: {
        rules: {
          custom: [
            {
              id: 'boom',
              match: () => {
                throw new Error('kaboom');
              },
              emit: async () => null,
            },
          ],
        },
      },
    });

    expect(typeof report.ok).toBe('boolean');
    expect(report.output).toContain('wp:html');
    const item = report.items.find((entry) => entry.reason.includes('conversion error emitted as Custom HTML fallback'));
    expect(item).toBeDefined();
    expect(JSON.stringify(item?.details)).toContain('kaboom');
  });
});

describe('hardening (review fixes)', () => {
  it('does not treat a lookalike YouTube domain as an embed', async () => {
    const report = await convert('<iframe src="https://notyoutube.com/embed/dQw4w9WgXcQ"></iframe>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:embed');
  });

  it('does not treat a lookalike Vimeo domain as an embed', async () => {
    const report = await convert('<iframe src="https://evilvimeo.com/video/76979871"></iframe>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:embed');
  });

  it('still converts the real YouTube domain to an embed', async () => {
    const report = await convert('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>');

    expect(report.output).toContain('wp:embed');
    expect(report.output).toContain('"providerNameSlug":"youtube"');
  });

  it('does not treat an http (non-https) YouTube iframe as an embed', async () => {
    const report = await convert('<iframe src="http://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:embed');
  });

  it('falls back a paragraph containing a data: URL anchor to Custom HTML', async () => {
    const report = await convert('<p>x <a href="data:text/html,evil">l</a></p>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:paragraph');
    expect(report.items.some((item) => item.reason.includes('data:'))).toBe(true);
  });

  it('converts a multi-image figure to a gallery without dropping any image', async () => {
    const report = await convert(
      '<figure><img src="/a.jpg" alt="a"><img src="/b.jpg" alt="b"><figcaption>Two</figcaption></figure>',
    );

    expect(report.output).toContain('wp:gallery');
    expect(report.output).toContain('/a.jpg');
    expect(report.output).toContain('/b.jpg');
    expect(report.summary.invalid).toBe(0);
  });

  it('keeps a single-image figure as core/image, not a gallery', async () => {
    const report = await convert('<figure><img src="/a.jpg" alt="a"><figcaption>One</figcaption></figure>');

    expect(report.output).toContain('wp:image');
    expect(report.output).not.toContain('wp:gallery');
  });

  it('strips control-character-obfuscated javascript: URLs (no dangerous scheme in output)', async () => {
    const report = await convert('<p>x <a href="java\nscript:alert(1)">l</a> <a href="vbscript:x">m</a></p>');

    expect(/javascript:|vbscript:/i.test((report.output ?? '').replace(/\s/g, ''))).toBe(false);
    expect(report.items.some((item) => item.reason.includes('URL stripped'))).toBe(true);
  });

  it('strips executable iframe srcdoc before it reaches Custom HTML', async () => {
    const report = await convert('<iframe srcdoc="<script>evil()</script>" src="https://x.example/a"></iframe>');

    expect(report.output).not.toContain('srcdoc');
    expect(report.output).not.toContain('<script>');
    expect(report.items.some((item) => item.reason.includes('iframe srcdoc stripped'))).toBe(true);
  });

  it('keeps every child of a mixed figure (image + video) — no silent drop', async () => {
    const report = await convert(
      '<figure><img src="/a.jpg" alt="a"><video src="/v.mp4" controls></video><figcaption>Mixed</figcaption></figure>',
    );

    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('wp:image');
    expect(report.output).toContain('wp:video');
    expect(report.output).toContain('/a.jpg');
    expect(report.output).toContain('/v.mp4');
    expect(report.output).not.toContain('wp:gallery');
  });

  it('keeps image + text content of a figure together', async () => {
    const report = await convert('<figure><img src="/a.jpg" alt="a"><p>context</p></figure>');

    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('wp:image');
    expect(report.output).toContain('wp:paragraph');
    expect(report.output).toContain('context');
  });

  it('falls back a paragraph with an empty semantic time element to Custom HTML', async () => {
    const report = await convert('<p>At <time datetime="2026-01-01"></time> today</p>');

    expect(report.output).toContain('wp:html');
    expect(report.output).not.toContain('wp:paragraph');
    expect(report.output).toContain('datetime="2026-01-01"');
  });

  it('falls back a paragraph with an empty semantic anchor target to Custom HTML', async () => {
    const report = await convert('<p>Jump <a id="target" aria-label="t"></a> here</p>');

    expect(report.output).toContain('wp:html');
    expect(report.items.some((item) => item.reason.includes('empty element with semantic attributes'))).toBe(true);
    expect(report.output).toContain('id="target"');
  });

  it('strips an empty decorative inline element but keeps the paragraph native', async () => {
    const report = await convert('<p>Chevron <span class="chev"></span> stays</p>');

    expect(report.output).toContain('wp:paragraph');
    expect(report.summary.invalid).toBe(0);
    expect(report.items.some((item) => item.reason.includes('empty decorative inline element stripped'))).toBe(true);
  });

  it('carries a table caption into the serialized figcaption', async () => {
    const report = await convert('<table><caption>My cap</caption><tbody><tr><td>1</td></tr></tbody></table>');

    expect(report.output).toContain('wp:table');
    expect(report.output).toMatch(/<figcaption[^>]*>My cap<\/figcaption>/);
  });

  it('carries video tracks into the serialized block', async () => {
    const report = await convert(
      '<video src="/m.mp4" controls><track src="/c.vtt" kind="captions" srclang="en" label="EN"></video>',
    );

    expect(report.output).toContain('wp:video');
    expect(report.output).toContain('"tracks"');
    expect(report.output).toContain('/c.vtt');
  });

  it('preserves whitespace indentation and escaping in a code sample', async () => {
    const html = `<pre><code>function f() {\n    return a &lt; b;\n}</code></pre>`;
    const report = await convert(html);

    expect(report.output).toContain('wp:code');
    expect(report.summary.invalid).toBe(0);
    expect(report.output).toContain('    return');
    expect(report.output).toContain('&lt;');
  });
});
