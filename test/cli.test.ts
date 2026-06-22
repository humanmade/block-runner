import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
});

function runCli(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'src/cli.ts', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
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
