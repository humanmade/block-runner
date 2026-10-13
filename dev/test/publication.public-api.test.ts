import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('does not introduce permanent recursive deletion into publication cleanup', async () => {
  const source = await readFile(new URL('../../src/plugin/profile.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\b(?:rm|rmdir|rmSync|rmdirSync)\s*\(/);
  expect(source).toContain("execFileAsync('trash', [stageDirectory])");
  expect(source).toContain("path.join(homedir(), '.Trash')");
});
