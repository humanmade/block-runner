import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  planStandalonePluginOutput,
  writePluginOutput,
} from '../../src/plugin/profile.js';

const block = {
  name: 'acme/notice',
  files: {
    'block.json': JSON.stringify({
      '$schema': 'https://schemas.wp.org/trunk/block.json',
      apiVersion: 3,
      name: 'acme/notice',
      title: 'Notice',
      category: 'widgets',
      editorScript: 'file:./index.js',
    }, null, 2),
    'index.js': "import { registerBlockType } from '@wordpress/blocks';\nimport metadata from './block.json';\nregisterBlockType( metadata.name, { edit: () => 'Notice', save: () => 'Notice' } );\n",
    'style.css': '.wp-block-acme-notice { color: rebeccapurple; }\n',
  },
};

describe('standalone lock confirmation', () => {
  it('writes every confirmed byte, including the complete lock, without npm', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-standalone-confirmation-'));
    const output = path.join(root, 'notice-plugin');
    const plan = await planStandalonePluginOutput(output, block);
    const repeat = await planStandalonePluginOutput(output, block);
    const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    const previewed = new Map(plan.touchedFiles.map((file) => [file.path, hash(file.content)]));

    expect(repeat.fingerprint).toBe(plan.fingerprint);
    expect(repeat.touchedFiles.map((file) => [file.path, hash(file.content)])).toEqual(
      plan.touchedFiles.map((file) => [file.path, hash(file.content)]),
    );

    // A confirmed write never invokes npm, so it succeeds even when no executable can be found.
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(root, 'no-executables');
    try {
      const result = await writePluginOutput(plan);
      expect(result.fingerprint).toBe(plan.fingerprint);
      expect(result.written).toEqual([...previewed.keys()].sort());
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    for (const file of plan.touchedFiles) {
      expect(hash(await readFile(file.path))).toBe(previewed.get(file.path));
    }
    const previewedLock = plan.touchedFiles.find((file) => file.relativePath === 'package-lock.json')!;
    expect(await readFile(path.join(output, 'package-lock.json'))).toEqual(previewedLock.content);
  });
});
