import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceSkill = new URL('../skills/block-runner/', import.meta.url);
const tsxImport = import.meta.resolve('tsx');
const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

describe('CLI', () => {
  it('prints the agent guide with skill', async () => {
    const result = await runCli(['skill']);
    const guide = await readFile(new URL('references/GUIDE.md', sourceSkill), 'utf8');

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(guide);
  });

  it('installs the canonical skill to both project locations by default', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const resolvedProject = await realpath(project);
    const agentsDestination = path.join(resolvedProject, '.agents', 'skills', 'block-runner');
    const claudeDestination = path.join(resolvedProject, '.claude', 'skills', 'block-runner');
    const sourceGuide = await readFile(new URL('references/GUIDE.md', sourceSkill), 'utf8');
    const result = await runCli(['skill', '--install'], '', {}, project);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`installed ${agentsDestination}`);
    expect(result.stdout).toContain(`installed ${claudeDestination}`);
    for (const destination of [agentsDestination, claudeDestination]) {
      const skill = await readFile(path.join(destination, 'SKILL.md'), 'utf8');
      const guide = await readFile(path.join(destination, 'references', 'GUIDE.md'), 'utf8');
      expect(skill).toContain('name: block-runner');
      expect(skill).toContain(`block-runner@${packageVersion}`);
      expect(guide).toContain(`block-runner@${packageVersion}`);
      expect(skill).not.toContain('block-runner@latest');
      expect(sourceGuide).toContain('block-runner@testing author preview');
      expect(sourceGuide).not.toMatch(/block-runner@latest (?:author|plugin|proof)/);
      expect(guide).toContain(`block-runner@${packageVersion} author preview`);
      expect(guide).toContain(`block-runner@${packageVersion} plugin preview`);
      expect(guide).toContain(`block-runner@${packageVersion} proof`);
      expect(guide).toContain('block-runner@testing skill --install');
      expect(guide).not.toMatch(/block-runner@(?:latest|testing) (?:assemble|convert|validate|fix|author|plugin|proof)/);
      expect(JSON.parse(await readFile(path.join(destination, '.block-runner-install.json'), 'utf8'))).toMatchObject({
        schemaVersion: 1,
        skill: 'block-runner',
        source: 'skills/block-runner',
        packageVersion,
        scope: 'project',
        target: destination === agentsDestination ? 'agents' : 'claude',
        files: {
          'SKILL.md': { sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), mode: expect.any(Number) },
          'references/GUIDE.md': { sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), mode: expect.any(Number) },
        },
      });
    }

    const unchanged = await runCli(['skill', '--install'], '', {}, project);
    expect(unchanged.stdout).toContain(`unchanged ${agentsDestination}`);
    expect(unchanged.stdout).toContain(`unchanged ${claudeDestination}`);
  });

  it('narrows installation with --target agents or --target claude', async () => {
    const agentsProject = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const claudeProject = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const agents = await runCli(['skill', '--install', '--target', 'agents'], '', {}, agentsProject);
    const claude = await runCli(['skill', '--install', '--target', 'claude'], '', {}, claudeProject);

    expect(agents.code).toBe(0);
    expect(await stat(path.join(agentsProject, '.agents', 'skills', 'block-runner', 'SKILL.md'))).toBeTruthy();
    await expect(stat(path.join(agentsProject, '.claude'))).rejects.toThrow();
    expect(claude.code).toBe(0);
    expect(await stat(path.join(claudeProject, '.claude', 'skills', 'block-runner', 'SKILL.md'))).toBeTruthy();
    await expect(stat(path.join(claudeProject, '.agents'))).rejects.toThrow();
  });

  it('installs under the user home with --scope user', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const home = await mkdtemp(path.join(tmpdir(), 'block-runner-home-'));
    const result = await runCli(['skill', '--install', '--scope', 'user', '--target', 'agents'], '', { HOME: home }, project);

    expect(result.code).toBe(0);
    expect(await stat(path.join(home, '.agents', 'skills', 'block-runner', 'SKILL.md'))).toBeTruthy();
    await expect(stat(path.join(project, '.agents'))).rejects.toThrow();
  });

  it('installs every canonical file under a --dir override', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const root = path.join(project, 'another-agent', 'skills');
    const destination = path.join(root, 'block-runner');
    const result = await runCli(['skill', '--install', '--dir', root], '', {}, project);

    expect(result.code).toBe(0);
    expect(await stat(path.join(destination, 'SKILL.md'))).toBeTruthy();
    expect(await stat(path.join(destination, 'references', 'GUIDE.md'))).toBeTruthy();
    expect((await stat(path.join(destination, 'SKILL.md'))).mode & 0o777).toBe(
      (await stat(fileURLToPath(new URL('SKILL.md', sourceSkill)))).mode & 0o777,
    );
    expect((await listFiles(destination)).filter((file) => file !== '.block-runner-install.json')).toEqual(
      await listFiles(fileURLToPath(sourceSkill)),
    );
  });

  it('reports both default destinations without writing in a dry run', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const resolvedProject = await realpath(project);
    const result = await runCli(['skill', '--install', '--dry-run'], '', {}, project);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`would install ${path.join(resolvedProject, '.agents', 'skills', 'block-runner')}`);
    expect(result.stdout).toContain(`would install ${path.join(resolvedProject, '.claude', 'skills', 'block-runner')}`);
    await expect(stat(path.join(project, '.agents'))).rejects.toThrow();
    await expect(stat(path.join(project, '.claude'))).rejects.toThrow();
  });

  it('refuses local changes unless --force is explicit', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const root = path.join(project, 'skills');
    const skillPath = path.join(root, 'block-runner', 'SKILL.md');
    expect((await runCli(['skill', '--install', '--dir', root], '', {}, project)).code).toBe(0);
    await writeFile(skillPath, 'local changes\n');

    const refused = await runCli(['skill', '--install', '--dir', root], '', {}, project);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('has local or unmanaged changes');
    expect(await readFile(skillPath, 'utf8')).toBe('local changes\n');

    const forced = await runCli(['skill', '--install', '--dir', root, '--force'], '', {}, project);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain(`updated ${path.join(root, 'block-runner')}`);
    expect(await readFile(skillPath, 'utf8')).toContain('name: block-runner');
  });

  it('preserves files it does not manage', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const root = path.join(project, 'skills');
    const destination = path.join(root, 'block-runner');
    expect((await runCli(['skill', '--install', '--dir', root], '', {}, project)).code).toBe(0);
    await writeFile(path.join(destination, 'LOCAL-NOTES.md'), 'keep me\n');

    const result = await runCli(['skill', '--install', '--dir', root], '', {}, project);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`unchanged ${destination}`);
    expect(await readFile(path.join(destination, 'LOCAL-NOTES.md'), 'utf8')).toBe('keep me\n');
  });

  it('fails closed then preserves the root guide when migrating a pre-manifest install', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const root = path.join(project, 'skills');
    const destination = path.join(root, 'block-runner');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'SKILL.md'), 'legacy skill\n');
    await writeFile(path.join(destination, 'GUIDE.md'), 'legacy guide\n');

    const refused = await runCli(['skill', '--install', '--dir', root], '', {}, project);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('unmanaged changes');

    const forced = await runCli(['skill', '--install', '--dir', root, '--force'], '', {}, project);
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain('preserved unmanaged file');
    expect(await readFile(path.join(destination, 'GUIDE.md'), 'utf8')).toBe('legacy guide\n');
    expect(await readFile(path.join(destination, 'references', 'GUIDE.md'), 'utf8')).toContain(
      '# Block Runner — agent guide',
    );
  });

  it('rejects ambiguous installer options and install-only flags', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const ambiguous = await runCli(
      ['skill', '--install', '--dir', path.join(project, 'skills'), '--target', 'claude'],
      '',
      {},
      project,
    );
    const noInstall = await runCli(['skill', '--dry-run'], '', {}, project);

    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain('--dir cannot be combined with --scope or --target');
    expect(noInstall.code).toBe(2);
    expect(noInstall.stderr).toContain('require --install');
  });

  it('refuses to install over the canonical source directory', async () => {
    const sourceRoot = path.dirname(fileURLToPath(sourceSkill));
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const sourceAlias = path.join(project, 'source-alias');
    await symlink(sourceRoot, sourceAlias);
    const result = await runCli(['skill', '--install', '--dir', sourceRoot]);
    const throughParentLink = await runCli(['skill', '--install', '--dir', sourceAlias]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('refusing to install over the canonical source skill');
    expect(throughParentLink.code).toBe(2);
    expect(throughParentLink.stderr).toContain('refusing to install over the canonical source skill');
  });

  it('rejects wrong-type and symbolic-link destinations', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const fileRoot = path.join(project, 'file-root');
    const linkRoot = path.join(project, 'link-root');
    const linkedDestination = path.join(project, 'linked-skill');
    await mkdir(fileRoot);
    await mkdir(linkRoot);
    await writeFile(path.join(fileRoot, 'block-runner'), 'not a directory\n');
    await writeFile(linkedDestination, 'not a skill directory\n');
    await symlink(linkedDestination, path.join(linkRoot, 'block-runner'));

    const wrongType = await runCli(['skill', '--install', '--dir', fileRoot], '', {}, project);
    const symbolicLink = await runCli(['skill', '--install', '--dir', linkRoot], '', {}, project);

    expect(wrongType.code).toBe(2);
    expect(wrongType.stderr).toContain('skill destination is not a directory');
    expect(symbolicLink.code).toBe(2);
    expect(symbolicLink.stderr).toContain('symbolic-link destination');
  });

  it('rejects a symbolic-link skills root before it can redirect the install', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const outside = path.join(project, 'outside-skills');
    const linkedRoot = path.join(project, 'linked-skills');
    await mkdir(outside);
    await symlink(outside, linkedRoot);

    const result = await runCli(['skill', '--install', '--dir', linkedRoot], '', {}, project);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('symbolic-link path');
    await expect(stat(path.join(outside, 'block-runner'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'preflights both default destinations before changing either one',
    async () => {
      const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
      const claudeRoot = path.join(project, '.claude');
      await mkdir(claudeRoot);
      await chmod(claudeRoot, 0o555);

      try {
        const result = await runCli(['skill', '--install'], '', {}, project);

        expect(result.code).toBe(2);
        expect(result.stderr).toContain('skill install path is not writable');
        await expect(stat(path.join(project, '.agents'))).rejects.toThrow();
      } finally {
        await chmod(claudeRoot, 0o755);
      }
    },
  );

  it('rejects nested symlink escapes and manifest symlinks even with --force', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-cli-'));
    const nestedRoot = path.join(project, 'nested-root');
    const nestedDestination = path.join(nestedRoot, 'block-runner');
    const manifestRoot = path.join(project, 'manifest-root');
    const manifestDestination = path.join(manifestRoot, 'block-runner');
    const outside = path.join(project, 'outside');
    const outsideManifest = path.join(project, 'outside-manifest.json');
    await mkdir(nestedDestination, { recursive: true });
    await mkdir(manifestDestination, { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(nestedDestination, 'references'));
    await writeFile(outsideManifest, '{}\n');
    await symlink(outsideManifest, path.join(manifestDestination, '.block-runner-install.json'));

    const nested = await runCli(['skill', '--install', '--dir', nestedRoot, '--force'], '', {}, project);
    const manifest = await runCli(['skill', '--install', '--dir', manifestRoot, '--force'], '', {}, project);

    expect(nested.code).toBe(2);
    expect(nested.stderr).toContain('resolves outside the skill destination');
    await expect(stat(path.join(outside, 'GUIDE.md'))).rejects.toThrow();
    await expect(stat(path.join(nestedDestination, 'SKILL.md'))).rejects.toThrow();
    expect(manifest.code).toBe(2);
    expect(manifest.stderr).toContain('manifest is not a regular file');
    expect(await readFile(outsideManifest, 'utf8')).toBe('{}\n');
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
    const [relaxed, strict] = await Promise.all([
      runCli(['convert', '-', '--config', configPath, '--json'], html),
      runCli(['convert', '-', '--config', configPath, '--styling', 'strict', '--json'], html),
    ]);

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
  cwd = process.cwd(),
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxImport, new URL('../src/cli.ts', import.meta.url).pathname, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
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

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}
