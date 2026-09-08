import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const files = [{ path: 'package.json' }, { path: 'skills/block-runner/SKILL.md' }];

function packFilePaths(stdout: string) {
  const script = new URL('../scripts/check-private-refs.mjs', import.meta.url).href;
  const result = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { packFilePaths } from ${JSON.stringify(script)}; console.log(JSON.stringify(packFilePaths(${JSON.stringify(stdout)})));`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(result) as string[];
}

describe('npm pack JSON parsing', () => {
  it('uses the npm record after tsup JSON chatter', () => {
    const stdout = [
      JSON.stringify({ index: 'src/index.ts', cli: 'src/bin.ts' }),
      JSON.stringify([{ name: 'block-runner', files }]),
    ].join('\n');

    expect(packFilePaths(stdout)).toEqual(files.map((file) => file.path));
  });

  it('accepts npm array, name-keyed map, and standalone record formats', () => {
    expect(packFilePaths(JSON.stringify([{ name: 'block-runner', files }]))).toEqual(files.map((file) => file.path));
    expect(packFilePaths(JSON.stringify({ 'block-runner': { name: 'block-runner', files } }))).toEqual(files.map((file) => file.path));
    expect(packFilePaths(JSON.stringify({ name: 'block-runner', files }))).toEqual(files.map((file) => file.path));
  });

  it('skips malformed preamble JSON and finds the later npm record', () => {
    const stdout = `{ incomplete preamble\n${JSON.stringify([{ name: 'block-runner', files }])}`;

    expect(packFilePaths(stdout)).toEqual(files.map((file) => file.path));
  });

  it('fails closed when no complete npm record has a valid files list', () => {
    expect(() => packFilePaths('{ malformed json }\n{"name":"tsup","files":[{}]}\n[]')).toThrow(
      'npm pack --json did not include a files list',
    );
  });
});
