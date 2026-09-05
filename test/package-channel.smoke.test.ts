import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tsxImport = import.meta.resolve('tsx');
const cliPath = new URL('../src/cli.ts', import.meta.url).pathname;
const sourceGuide = new URL('../skills/block-runner/references/GUIDE.md', import.meta.url);

describe('package channel authoring smoke', () => {
  it('uses testing for the shipped authoring workflow while stable intentionally lacks author', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-channel-smoke-'));
    const bin = path.join(root, 'bin');
    const fakeNpx = path.join(bin, 'npx');
    await mkdir(bin);
    await writeFile(fakeNpx, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const packageIndex = args.findIndex((value) => value === 'block-runner@latest' || value === 'block-runner@testing');
const channel = args[packageIndex];
const command = args.slice(packageIndex + 1);
if (channel === 'block-runner@latest') {
  process.stderr.write('stable fixture: author is unavailable\\n');
  process.exit(2);
}
if (channel !== 'block-runner@testing') process.exit(3);
const result = spawnSync(process.execPath, ['--import', ${JSON.stringify(tsxImport)}, ${JSON.stringify(cliPath)}, ...command], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, 'utf8');
    await chmod(fakeNpx, 0o755);
    await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan()), 'utf8');

    const guide = await readFile(sourceGuide, 'utf8');
    expect(guide).toContain('npx -y block-runner@testing author preview authoring-plan.json');
    expect(guide).not.toContain('block-runner@latest author preview');

    const testing = await run(fakeNpx, [
      '-y', 'block-runner@testing', 'author', 'preview', 'plan.json', '--output-dir', 'generated', '--json',
    ], root);
    expect(testing.code).toBe(0);
    expect(JSON.parse(testing.stdout)).toMatchObject({ command: 'author preview', noFilesWritten: true });

    const stable = await run(fakeNpx, ['-y', 'block-runner@latest', 'author', 'preview', 'plan.json'], root);
    expect(stable.code).toBe(2);
    expect(stable.stderr).toContain('author is unavailable');
  });
});

function plan(): Record<string, unknown> {
  return {
    version: 1,
    generatorVersion: '0.9.0-preview.1',
    target: { name: 'example/notice', title: 'Notice' },
    structure: [],
    fields: [],
    locking: { mode: 'none' },
    styles: { strategy: 'native', outcomes: [] },
    pattern: { ready: false, overrides: [] },
    assets: [],
    files: [],
    warnings: [],
  };
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
