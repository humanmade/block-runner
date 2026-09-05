import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { author } from '../src/author/index.js';

async function fixture(): Promise<{ root: string; image: string; missing: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-author-media-'));
  await writeFile(path.join(root, 'photo.png'), 'not an image, but a readable source asset');
  return { root, image: 'photo.png', missing: 'missing.png' };
}

function markup(image: string, missing: string): string {
  return `<img src="${image}" alt="Prepared"><img src="${missing}" alt="Missing">`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTML authoring media isolation', () => {
  it('does not call a configured REST resolver during repeated analysis or asset validation failure', async () => {
    const input = await fixture();
    const fetch = vi.fn(() => {
      throw new Error('author analysis must not contact the REST media boundary');
    });
    vi.stubGlobal('fetch', fetch);

    const options = {
      sourcePath: path.join(input.root, 'design.html'),
      author: { name: 'example/media' },
      config: { media: { resolver: 'rest' as const, wpUrl: 'https://wordpress.example.test', allowRemote: true } },
    };
    const first = await author(markup(input.image, input.missing), options);
    const second = await author(markup(input.image, input.missing), options);

    expect(fetch).not.toHaveBeenCalled();
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(first.assets).toContainEqual(expect.objectContaining({ reference: input.missing, outcome: 'unresolved' }));
    expect(first.output).toContain('./assets/');
    expect(first.output).not.toMatch(/"id"\s*:\s*\d+/);
  });

  it('does not invoke configured WP-CLI lookup or import during repeated analysis', async () => {
    const input = await fixture();
    const bin = path.join(input.root, 'bin');
    const wp = path.join(bin, 'wp');
    const audit = path.join(input.root, 'wp-invocations.log');
    await mkdir(bin);
    await writeFile(wp, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(audit)}\nexit 1\n`);
    await chmod(wp, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;

    try {
      const options = {
        sourcePath: path.join(input.root, 'design.html'),
        author: { name: 'example/media' },
        config: { media: { resolver: 'wpcli' as const, wpUrl: 'https://wordpress.example.test', allowRemote: true } },
      };
      const first = await author(markup(input.image, input.missing), options);
      const second = await author(markup(input.image, input.missing), options);

      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      await expect(stat(audit)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(first.assets).toContainEqual(expect.objectContaining({ reference: input.missing, outcome: 'unresolved' }));
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
