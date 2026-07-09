import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI', () => {
  it('validates stdin and emits JSON', async () => {
    const result = await runCli(['validate', '-', '--json'], '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->');
    const report = JSON.parse(result.stdout) as { ok: boolean; command: string };

    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.command).toBe('validate');
  });

  it('returns exit code 1 for invalid markup', async () => {
    const result = await runCli(['validate', '-'], '<!-- wp:paragraph --><h2>Hello</h2><!-- /wp:paragraph -->');

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('problems found');
  });

  it('loads --config for conversion options', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const configPath = path.join(dir, 'block-runner.config.mjs');
    await writeFile(
      configPath,
      `export default { media: { resolver: 'map', map: { 'hero.jpg': { id: 55, url: 'https://example.test/hero.jpg' } } } };`,
    );
    const result = await runCli(
      ['convert', '-', '--config', configPath, '--json'],
      '<section style="background-image:url(hero.jpg)"><h1>Hello</h1></section>',
    );
    const report = JSON.parse(result.stdout) as { ok: boolean; output: string; summary: { warnings: number } };

    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.output).toContain('"id":55');
    expect(report.summary.warnings).toBe(0);
  });

  it('prints help and version with exit code 0', async () => {
    const help = await runCli(['--help']);
    const version = await runCli(['--version']);
    const { version: packageVersion } = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(new URL('../package.json', import.meta.url), 'utf8')),
    ) as { version: string };

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage:');
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(packageVersion);
  });

  it('converts inline HTML positionals', async () => {
    const result = await runCli(['convert', '<p>Hello</p>', '--json']);
    const report = JSON.parse(result.stdout) as { ok: boolean; output: string };

    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.output).toContain('<p>Hello</p>');
  });

  it('rejects validate --out instead of ignoring it', async () => {
    const result = await runCli(['validate', '-', '--out', 'report.txt'], '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->');

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown option');
  });

  it('does not write --out when conversion fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const inputPath = path.join(dir, 'embed.html');
    const outPath = path.join(dir, 'out.html');
    await writeFile(inputPath, '<iframe src="https://example.test/embed"></iframe>');
    const result = await runCli(['convert', inputPath, '--strict', '--out', outPath]);

    expect(result.code).toBe(2);
    await expect(stat(outPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to overwrite the input path with --out', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const inputPath = path.join(dir, 'post.html');
    const original = '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->';
    await writeFile(inputPath, original);
    const result = await runCli(['fix', inputPath, '--out', inputPath]);

    expect(result.code).toBe(2);
    expect(await readFile(inputPath, 'utf8')).toBe(original);
  });

  it('accepts REST app passwords by environment variable indirection', async () => {
    const result = await runCli(
      ['convert', '<img src="photo.jpg">', '--resolver', 'rest', '--wp-app-password-env', 'BLOCK_RUNNER_TEST_PASSWORD', '--json'],
      '',
      {
        BLOCK_RUNNER_TEST_PASSWORD: 'secret-from-env',
      },
    );
    const report = JSON.parse(result.stdout) as { ok: boolean; items: Array<{ details?: { resolver?: string } }> };

    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(result.stdout).not.toContain('secret-from-env');
    expect(report.items.some((item) => item.details?.resolver === 'rest')).toBe(true);
  });
});

function runCli(
  args: string[],
  input = '',
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'src/cli.ts', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
