import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureContractFailures, type AuthoringFixture } from '../scripts/authoring/score.js';

function fixture(artifactRoot: string): AuthoringFixture {
  return {
    id: 'style-ledger-validation',
    family: 'styles',
    source: { producer: 'unit-test', style: 'semantic-html' },
    candidate: { artifactRoot, requiredFiles: ['style-ledger.json'] },
  };
}

async function failures(property: string, value: string): Promise<string[]> {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-style-ledger-'));
  const artifactRoot = path.join(root, 'candidate');
  await mkdir(artifactRoot);
  await writeFile(path.join(artifactRoot, 'style-ledger.json'), JSON.stringify({
    version: 1,
    entries: [{
      selector: '.example',
      property,
      value,
      editorControl: 'scoped-css',
      owner: 'block',
      source: { path: 'source.html', line: 1, column: 1 },
    }],
  }));
  return fixtureContractFailures(fixture(artifactRoot), root);
}

describe('authoring style-ledger receipt validation', () => {
  it('accepts an empty value only for a valid custom property', async () => {
    expect(await failures('--tw-placeholder', '')).toEqual([]);
  });

  it.each([
    ['ordinary property', 'color'],
    ['invalid custom property', '--'],
    ['whitespace custom property', '--tw-placeholder '],
  ])('rejects an empty value for a %s', async (_label, property) => {
    expect(await failures(property, '')).toContain('style-ledger entry 0 requires value');
  });
});
