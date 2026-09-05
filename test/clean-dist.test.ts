import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('moves only the fixed build directory to recoverable storage when the trash CLI is unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-clean-'));
  await mkdir(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts/clean-dist.mjs');
  await copyFile(new URL('../scripts/clean-dist.mjs', import.meta.url), script);
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist/marker.txt'), 'Recover this exact build.');
  await writeFile(path.join(root, 'keep.txt'), 'Do not touch source.');

  await expect(exec(process.execPath, [script, '..'])).rejects.toThrow('clean-dist accepts no arguments');
  expect(await readFile(path.join(root, 'dist/marker.txt'), 'utf8')).toBe('Recover this exact build.');
  const { stdout } = await exec(process.execPath, [script], { env: { ...process.env, PATH: '' } });
  const destination = stdout.trim().replace(/^Moved previous dist to /, '');
  const storageDirectories = await Promise.all([
    path.join(homedir(), '.Trash'),
    path.join(root, '.block-runner-trash'),
  ].map(async (directory) => realpath(directory).catch(() => path.resolve(directory))));
  expect(storageDirectories).toContain(await realpath(path.dirname(destination)));
  expect(path.basename(destination)).toMatch(/^block-runner-dist-[a-f0-9-]+$/);
  expect(await readFile(path.join(destination, 'marker.txt'), 'utf8')).toBe('Recover this exact build.');
  expect(await readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('Do not touch source.');
  await expect(stat(path.join(root, 'dist'))).rejects.toThrow();
  await expect(exec(process.execPath, [script], { env: { ...process.env, PATH: '' } })).resolves.toMatchObject({ stdout: '' });
});
