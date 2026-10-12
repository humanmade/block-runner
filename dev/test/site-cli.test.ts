import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tsxImport = import.meta.resolve('tsx');
const cliPath = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent', import.meta.url));
const intentPath = path.join(fixtureRoot, 'site.intent.json');

describe('site compile CLI', () => {
  it('requires an explicit asset root before reading or publishing a bundle', async () => {
    const project = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-site-cli-'));
    const output = path.join(project, 'bundle');
    const result = await runCli(['site', 'compile', intentPath, '--out', output, '--theme-only', '--json'], project);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("required option '--asset-root <dir>' not specified");
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes theme-only output with pending page bindings and no runtime-proof claim', async () => {
    const project = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-site-cli-'));
    const output = path.join(project, 'bundle');
    const result = await runCli([
      'site', 'compile', intentPath, '--asset-root', fixtureRoot, '--out', output, '--theme-only', '--json',
    ], project);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      artifactType: string;
      pendingPageBindings: Array<{ assetId: string }>;
      runtimeProof: string;
      files: Array<{ path: string }>;
    };
    expect(report.artifactType).toBe('theme');
    expect(report.pendingPageBindings).toContainEqual(expect.objectContaining({ assetId: 'home-hero' }));
    expect(report.runtimeProof).toBe('not-run');
    expect(report.files.map((file) => file.path)).toContain('theme/functions.php');
    expect(await readFile(path.join(output, 'theme/assets/styles/site.css'), 'utf8')).toContain('--site-ink');
    const manifest = JSON.parse(await readFile(path.join(output, 'site.manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ artifactType: 'theme', pendingPageBindings: report.pendingPageBindings });
  });

  it('refuses full-site publication when required attachment bindings are missing', async () => {
    const project = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-site-cli-'));
    const output = path.join(project, 'bundle');
    const result = await runCli([
      'site', 'compile', intentPath, '--asset-root', fixtureRoot, '--out', output, '--json',
    ], project);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, filesWritten: false });
    expect(result.stdout).toContain('attachment-binding-required');
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxImport, cliPath, ...args], {
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
