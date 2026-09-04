import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { author } from '../src/author/index.js';
import { compileRegisteredBlock } from '../src/authoring/generate.js';
import { PROOF_SVG_SOURCE } from '../src/proof/fixture-image.js';

describe('HTML analysis uses the confirmed compiler', () => {
  it('returns exact canonical source with responsive CSS, editor CSS, native fields, and SVG transport', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-html-plan-'));
    await writeFile(path.join(root, 'logo.svg'), PROOF_SVG_SOURCE);
    const before = await readdir(root);
    const result = await author('<div class="card"><h2>Heading</h2><img src="logo.svg" alt="A check mark"></div>', {
      sourcePath: path.join(root, 'design.html'), author: { name: 'example/design', locking: { mode: 'contentOnly' },
        styles: { mode: 'css', css: '@media (min-width: 48rem) { .card:hover { transform: translateY(-2px); } }',
          editorCss: '.card:focus-within { outline: 2px solid blue; }' } },
    });
    expect(result.ok, JSON.stringify(result.items)).toBe(true);
    const plan = result.package!.canonicalPlan!;
    expect(plan.source).toEqual({
      entry: path.join(root, 'design.html'),
      sha256: createHash('sha256').update('<div class="card"><h2>Heading</h2><img src="logo.svg" alt="A check mark"></div>').digest('hex'),
      format: 'html',
    });
    expect(result.source).toEqual(plan.source);
    expect(plan.coverage?.styles).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'transform', scope: 'shared', outcome: 'scoped-css' }),
      expect.objectContaining({ property: 'outline', scope: 'editor', outcome: 'scoped-css' }),
    ]));
    expect(plan.coverage?.assets).toContainEqual(expect.objectContaining({
      reference: 'logo.svg', outcome: 'prepared', sha256: createHash('sha256').update(PROOF_SVG_SOURCE).digest('hex'),
    }));
    expect(plan.locking.mode).toBe('contentOnly');
    expect(plan.fields).toContainEqual(expect.objectContaining({ attribute: 'alt', mode: 'editable' }));
    const generated = compileRegisteredBlock(plan);
    expect(result.package!.files).toEqual(Object.fromEntries(generated.files.map((file) => [file.path, file.content])));
    expect(result.package!.manifest).toEqual(generated.manifest);
    expect(result.package!.files['style.scss']).toContain('@media (min-width: 48rem)');
    expect(result.package!.files['editor.scss']).toContain('focus-within');
    expect(result.package!.files['asset-urls.mjs']).toContain('new URL(');
    expect(generated.assets[0]!.content.toString()).toBe(PROOF_SVG_SOURCE);
    expect(await readdir(root)).toEqual(before);
  });

  it('refuses editor CSS that escapes the component before writing any source', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-html-plan-'));
    const outDir = path.join(root, 'generated');
    const result = await author('<p>Hello</p>', { outDir,
      author: { name: 'example/design', styles: { editorCss: 'body { color:red }' } } });
    expect(result.ok).toBe(false);
    expect(result.package).toBeUndefined();
    expect(result.items.some((item) => item.reason.includes('Editor-only CSS'))).toBe(true);
    await expect(readFile(path.join(outDir, 'block.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
