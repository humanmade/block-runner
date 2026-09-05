import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  PublicationInterruptedError,
  PluginPublicationInterruptedError,
  retryAuthoringPublication,
  retryPluginPublication,
  type ProofBrowserMatrix,
} from '../src/index.js';

it('retains the guarded public API while adding recovery entry points', () => {
  const matrix: ProofBrowserMatrix['rootLayout'] = 'grid';
  expect(matrix).toBe('grid');
  expect(PublicationInterruptedError.prototype).toBeInstanceOf(Error);
  expect(PluginPublicationInterruptedError.prototype).toBeInstanceOf(Error);
  expect(retryAuthoringPublication).toBeTypeOf('function');
  expect(retryPluginPublication).toBeTypeOf('function');
});

it('does not introduce permanent recursive deletion into publication cleanup', async () => {
  const source = await readFile(new URL('../src/plugin/profile.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\b(?:rm|rmdir|rmSync|rmdirSync)\s*\(/);
  expect(source).toContain("execFileAsync('trash', [stageDirectory])");
  expect(source).toContain("path.join(homedir(), '.Trash')");
});
