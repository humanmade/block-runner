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

  it('forwards --styling through to the converter', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const configPath = path.join(dir, 'block-runner.config.mjs');
    await writeFile(configPath, `export default { tokens: { colors: { base: '#f5f5f5' } } };`);
    const html = '<div style="background:#f5f5f5;letter-spacing:2px"><p>Hi</p></div>';

    // relaxed (the default) keeps the off-system value; strict drops it. If the flag were not
    // forwarded, both runs would produce identical output.
    const relaxed = await runCli(['convert', '-', '--config', configPath, '--json'], html);
    const strict = await runCli(['convert', '-', '--config', configPath, '--styling', 'strict', '--json'], html);

    const relaxedReport = JSON.parse(relaxed.stdout) as { output: string };
    const strictReport = JSON.parse(strict.stdout) as { output: string };

    expect(relaxedReport.output).toContain('letterSpacing');
    expect(strictReport.output).not.toContain('letterSpacing');
    // Both snap the on-system colour to its preset.
    expect(strictReport.output).toContain('"backgroundColor":"base"');
  });

  it('rejects an unimplemented --styling rung instead of silently downgrading', async () => {
    const result = await runCli(['convert', '-', '--styling', 'source'], '<div style="padding:8px">Hi</div>');

    // 2, not 1: an invalid flag value is a usage error, per the documented exit codes.
    expect(result.code).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('not implemented yet');
  });

  it('refuses --styling open without a sink for the sidecar CSS', async () => {
    // The rung preserves CSS by emitting a stylesheet the caller must ship; with nowhere to put it,
    // that CSS would be silently lost, so this is an error rather than a warning.
    const result = await runCli(['convert', '-', '--styling', 'open'], '<div style="max-width:600px">Hi</div>');

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--css-out');
  });

  it('refuses config-set styling: open without a sink, not just the flag', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const configPath = path.join(dir, 'block-runner.config.mjs');
    await writeFile(configPath, `export default { styling: 'open' };`);

    const result = await runCli(
      ['convert', '-', '--config', configPath],
      '<div style="max-width:600px"><p>Hi</p></div>',
    );

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--css-out');
  });

  it('writes sidecar CSS to --css-out', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const cssPath = path.join(dir, 'sidecar.css');
    const result = await runCli(
      ['convert', '-', '--styling', 'open', '--css-out', cssPath],
      '<div style="max-width:600px"><p>Hi</p></div>',
    );

    expect(result.code).toBe(0);
    expect(await readFile(cssPath, 'utf8')).toContain('max-width:600px');
    // The class the rule selects must actually be on the block, or the CSS selects nothing.
    const className = /\.(br-[0-9a-f]+)/.exec(await readFile(cssPath, 'utf8'))?.[1];
    expect(result.stdout).toContain(className!);
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
