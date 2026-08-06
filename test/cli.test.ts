import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI', () => {
  it('prints the agent guide with skill', async () => {
    const result = await runCli(['skill']);
    const guide = await readFile(new URL('../skill/GUIDE.md', import.meta.url), 'utf8');

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(guide);
  });

  it('installs both agent skill files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const destination = path.join(dir, 'block-runner');
    const result = await runCli(['skill', '--install', '--dir', dir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`installed ${path.join(destination, 'SKILL.md')}`);
    expect(result.stdout).toContain(`installed ${path.join(destination, 'GUIDE.md')}`);
    expect(await readFile(path.join(destination, 'SKILL.md'), 'utf8')).toBe(
      await readFile(new URL('../skill/SKILL.md', import.meta.url), 'utf8'),
    );
    expect(await readFile(path.join(destination, 'GUIDE.md'), 'utf8')).toBe(
      await readFile(new URL('../skill/GUIDE.md', import.meta.url), 'utf8'),
    );

    const updated = await runCli(['skill', '--install', '--dir', dir]);
    expect(updated.stdout).toContain(`updated ${path.join(destination, 'SKILL.md')}`);
    expect(updated.stdout).toContain(`updated ${path.join(destination, 'GUIDE.md')}`);
  });

  it('installs the agent skill under a --dir override', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const destination = path.join(dir, 'cursor', 'rules', 'block-runner');
    const result = await runCli(['skill', '--install', '--dir', path.join(dir, 'cursor', 'rules')]);

    expect(result.code).toBe(0);
    expect(await stat(path.join(destination, 'SKILL.md'))).toBeTruthy();
    expect(await stat(path.join(destination, 'GUIDE.md'))).toBeTruthy();
  });

  it('adds a convert hint for Custom HTML fallbacks without changing warning counts', async () => {
    const result = await runCli(['convert', '-', '--json'], '<iframe src="https://example.test/embed"></iframe>');
    const report = JSON.parse(result.stdout) as {
      hint?: string;
      summary: { warnings: number };
      items: Array<{ reason: string }>;
    };

    expect(result.code).toBe(0);
    expect(report.hint).toBe(
      '1 block fell back to Custom HTML — describing the structure as an intent tree usually converts cleanly: npx block-runner skill',
    );
    expect(report.summary.warnings).toBe(1);
    expect(report.items.some((item) => item.reason === report.hint)).toBe(false);
  });

  it('does not add a convert hint when there is no fallback', async () => {
    const result = await runCli(['convert', '-', '--json'], '<p>Hello</p>');
    const report = JSON.parse(result.stdout) as { hint?: string };

    expect(result.code).toBe(0);
    expect(report.hint).toBeUndefined();
  });

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

  it('assembles intent from stdin and repairs tokens through CLI resolver options', async () => {
    const themeJson = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'theme.json');
    const intent = JSON.stringify({
      blocks: [
        {
          block: 'core/group',
          attrs: { style: { color: { background: '#0073aa' } } },
          children: [{ block: 'core/paragraph', text: 'Brand block' }],
        },
      ],
    });
    const result = await runCli(
      ['assemble', '-', '--token-resolver', 'file', '--theme-json', themeJson, '--json'],
      intent,
    );
    const report = JSON.parse(result.stdout) as { ok: boolean; command: string; output: string };

    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.command).toBe('assemble');
    expect(report.output).toContain('"backgroundColor":"primary"');
    expect(report.output).toContain('has-primary-background-color');
  });

  it('returns exit code 1 for malformed inline intent', async () => {
    const result = await runCli(['assemble', 'not-json', '--json']);
    const report = JSON.parse(result.stdout) as { ok: boolean; items: Array<{ reason: string }> };

    expect(result.code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.items[0]?.reason).toBe('could not parse intent JSON');
  });

  it('rejects styling flags on assemble and points callers to convert', async () => {
    for (const args of [
      ['assemble', '-', '--styling', 'strict'],
      ['assemble', '-', '--css-out', 'sidecar.css'],
    ]) {
      const result = await runCli(args, '{"blocks":[]}');
      const output = `${result.stdout}${result.stderr}`;

      expect(result.code).toBe(2);
      expect(output).toContain('does not apply to intent trees');
      expect(output).toContain('block-runner convert');
    }
  });

  it('warns instead of failing when assemble config sets a non-default styling rung', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const configPath = path.join(dir, 'block-runner.config.mjs');
    await writeFile(configPath, `export default { styling: 'open' };`);
    const result = await runCli(
      ['assemble', '-', '--config', configPath, '--json'],
      '{"blocks":[{"block":"core/paragraph","text":"Hi"}]}',
    );
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      items: Array<{ status: string; reason: string }>;
    };

    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        status: 'warning',
        reason: expect.stringContaining('does not apply to intent trees'),
      }),
    );
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
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
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
