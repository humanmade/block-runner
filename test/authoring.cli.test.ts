import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashAuthoringPlan } from '../src/authoring/schema.js';

const tsxImport = import.meta.resolve('tsx');

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    files: [{ path: 'block.json', content: '{"apiVersion":3}\n', operation: 'create' }],
    warnings: [],
    ...overrides,
  };
}

describe('author CLI', () => {
  it('previews without writing and only writes the exact confirmed canonical plan', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-author-cli-'));
    const input = plan();
    await writeFile(path.join(project, 'plan.json'), JSON.stringify(input));

    const preview = await runCli(['author', 'preview', 'plan.json', '--output-dir', 'generated', '--width', '62', '--json'], project);
    expect(preview.code).toBe(0);
    const previewJson = JSON.parse(preview.stdout) as { hash: string; preview: string; noFilesWritten: boolean };
    expect(previewJson.noFilesWritten).toBe(true);
    expect(previewJson.preview).toContain('No files written.');
    expect(preview.stdout).not.toMatch(/\x1b\[/);
    await expect(stat(path.join(project, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' });

    const wrong = await runCli(
      ['author', 'write', 'plan.json', '--confirm', '0'.repeat(64), '--output-dir', 'generated', '--json'],
      project,
    );
    expect(wrong.code).toBe(2);
    await expect(stat(path.join(project, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' });

    const otherDestination = await runCli(
      ['author', 'write', 'plan.json', '--confirm', previewJson.hash, '--output-dir', 'elsewhere', '--json'],
      project,
    );
    expect(otherDestination.code).toBe(2);
    await expect(stat(path.join(project, 'elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' });

    const written = await runCli(
      ['author', 'write', 'plan.json', '--confirm', previewJson.hash, '--output-dir', 'generated', '--json'],
      project,
    );
    expect(written.code).toBe(0);
    expect(JSON.parse(written.stdout)).toMatchObject({ written: ['block.json'], noFilesWritten: false });
    expect(await readFile(path.join(project, 'generated', 'block.json'), 'utf8')).toBe('{"apiVersion":3}\n');
  });

  it('rejects approval when the previewed destination fingerprint has changed', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-author-cli-'));
    const destination = path.join(project, 'generated');
    await mkdir(destination);
    await writeFile(path.join(destination, 'block.json'), 'before\n');
    await writeFile(path.join(project, 'plan.json'), JSON.stringify(plan({
      files: [{ path: 'block.json', content: 'replacement\n', operation: 'replace' }],
    })));

    const preview = await runCli(['author', 'preview', 'plan.json', '--output-dir', 'generated', '--json'], project);
    expect(preview.code).toBe(0);
    const previewJson = JSON.parse(preview.stdout) as { hash: string };
    await writeFile(path.join(destination, 'block.json'), 'changed after preview\n');

    const result = await runCli(
      ['author', 'write', 'plan.json', '--confirm', previewJson.hash, '--output-dir', 'generated', '--json'],
      project,
    );
    expect(result.code).toBe(2);
    expect(await readFile(path.join(destination, 'block.json'), 'utf8')).toBe('changed after preview\n');
  });

  it('does not write when a canonical material decision changed after preview', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-author-cli-'));
    const original = plan();
    await writeFile(path.join(project, 'plan.json'), JSON.stringify(original));
    const hash = hashAuthoringPlan(original);
    await writeFile(path.join(project, 'plan.json'), JSON.stringify(plan({ warnings: ['changed'] })));

    const result = await runCli(['author', 'write', 'plan.json', '--confirm', hash, '--output-dir', 'generated'], project);
    expect(result.code).toBe(2);
    await expect(stat(path.join(project, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxImport, new URL('../src/cli.ts', import.meta.url).pathname, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}
