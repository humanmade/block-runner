import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Seeded faults in broken-theme: unregistered block, missing template-part slug, missing pattern
// slug, undeclared preset, unknown theme.json key, wrong theme.json type, and PHP pattern body.
const fixtureRoot = fileURLToPath(new URL('../fixtures/themes/', import.meta.url));
const tsxImport = import.meta.resolve('tsx');

describe('block theme folders', () => {
  it('reports recursive theme files individually and excludes pattern headers from block counts', async () => {
    const project = await copiedTheme('broken-theme');
    const templateMarkup = await readFile(path.join(project, 'parts', 'footer.html'), 'utf8');
    await mkdir(path.join(project, 'templates', 'nested'), { recursive: true });
    await mkdir(path.join(project, 'patterns', 'nested'), { recursive: true });
    await mkdir(path.join(project, 'patterns', 'vendor'), { recursive: true });
    await mkdir(path.join(project, 'templates', 'node_modules', 'hidden'), { recursive: true });
    await writeFile(path.join(project, 'templates', 'nested', 'UPPER.HTML'), templateMarkup);
    await writeFile(path.join(project, 'patterns', 'nested', 'uppercase.PHP'), '<?php ?>' + templateMarkup);
    await writeFile(path.join(project, 'patterns', 'vendor', 'ignored.php'), '<?php ?>' + templateMarkup);
    await writeFile(path.join(project, 'templates', 'node_modules', 'hidden', 'ignored.html'), templateMarkup);
    const result = await runCli(['validate', project, '--json']);
    const report = JSON.parse(result.stdout) as {
      summary: { blocks: number; warnings: number };
      files: Array<{ file: string; blocks: number; invalid: number; warnings: number }>;
      items: Array<{ reason: string }>;
    };

    expect(result.code).toBe(1);
    expect(report.files.map(({ file }) => file)).toEqual([
      'parts/footer.html', 'parts/header.html', 'patterns/callout.php', 'patterns/dynamic.php',
      'templates/index.html', 'templates/nested/UPPER.HTML', 'templates/node_modules/hidden/ignored.html', 'templates/single.html',
      'theme.json',
    ]);
    expect(report.files.find(({ file }) => file === 'patterns/callout.php')).toMatchObject({ blocks: 3, invalid: 0 });
    expect(report.files.find(({ file }) => file === 'patterns/dynamic.php')).toMatchObject({ blocks: 0, invalid: 0, warnings: 1 });
    expect(report.files.find(({ file }) => file === 'theme.json')).toMatchObject({ blocks: 0, invalid: 2 });
    expect(report.summary.warnings).toBeGreaterThanOrEqual(1);
    expect(report.items.some(({ reason }) => reason.includes('block validation was skipped'))).toBe(true);

    const text = await runCli(['validate', project]);
    expect(text.stdout).toContain('file=patterns/dynamic.php blocks=0 invalid=0 warnings=1');
  });

  // Four separate CLI cold starts each boot Gutenberg; CI needs a combined budget.
  it('writes canonical files atomically, preserves PHP headers, skips PHP bodies and is idempotent', async () => {
    const project = await copiedTheme('valid-theme');
    const templatePath = path.join(project, 'templates', 'index.html');
    const patternPath = path.join(project, 'patterns', 'callout.php');
    const dynamicSource = path.join(fixtureRoot, 'broken-theme', 'patterns', 'dynamic.php');
    const dynamicPath = path.join(project, 'patterns', 'dynamic.php');
    const originalTemplate = await readFile(templatePath, 'utf8');
    const originalPattern = await readFile(patternPath, 'utf8');
    const closeTagEnd = originalPattern.indexOf('?>') + 2;
    const originalHeader = originalPattern.slice(0, closeTagEnd);
    const header = `\uFEFF  \r\n${originalHeader}  \r\n`;
    const dynamic = await readFile(dynamicSource, 'utf8');
    await writeFile(templatePath, `\n${originalTemplate}`);
    await writeFile(patternPath, `${header}${originalPattern.slice(closeTagEnd)}`);
    await writeFile(dynamicPath, dynamic);
    await chmod(templatePath, 0o640);
    const dynamicBefore = await readFile(dynamicPath, 'utf8');

    const first = await runCli(['fix', project, '--write', '--json']);
    const firstReport = JSON.parse(first.stdout) as {
      files: Array<{ file: string; changed?: boolean; blocks: number; warnings: number }>;
    };

    expect(first.code).toBe(0);
    expect(firstReport.files.find(({ file }) => file === 'templates/index.html')?.changed).toBe(true);
    expect(firstReport.files.find(({ file }) => file === 'patterns/callout.php')).toMatchObject({ blocks: 3, warnings: 0, changed: true });
    expect((await readFile(patternPath, 'utf8')).startsWith(header)).toBe(true);
    expect(await readFile(dynamicPath, 'utf8')).toBe(dynamicBefore);
    expect((await stat(templatePath)).mode & 0o777).toBe(0o640);
    expect(await readFile(templatePath, 'utf8')).toBe(originalTemplate.replace(/^\n/, ''));

    const second = await runCli(['fix', project, '--write', '--json']);
    const secondReport = JSON.parse(second.stdout) as { files: Array<{ changed?: boolean }> };
    expect(second.code).toBe(0);
    expect(secondReport.files.every(({ changed }) => changed === false)).toBe(true);

    await writeFile(templatePath, `\n${await readFile(templatePath, 'utf8')}`);
    const textWrite = await runCli(['fix', project, '--write']);
    expect(textWrite.code).toBe(0);
    expect(textWrite.stdout).toContain('changed: templates/index.html');
  }, 60_000);

  it('rejects --write for a single file and rejects an output-path conflict', async () => {
    const project = await copiedTheme('valid-theme');
    const input = path.join(project, 'templates', 'index.html');
    const original = await readFile(input, 'utf8');
    const singleFile = await runCli(['fix', input, '--write']);
    const conflict = await runCli(['fix', project, '--write', '--out', path.join(project, 'out.html')]);

    expect(singleFile.code).toBe(2);
    expect(singleFile.stderr).toContain('--write is only available for a block theme directory');
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain('--write cannot be combined with --out');
    expect(await readFile(input, 'utf8')).toBe(original);
    expect(await readdir(project)).not.toContain('out.html');
  });

  it('reports and preserves a symlink theme target during an in-place fix', async () => {
    const project = await copiedTheme('valid-theme');
    const linkedPath = path.join(project, 'templates', 'index.html');
    const originalPath = path.join(project, 'templates', 'index.original.html');
    const externalPath = path.join(path.dirname(project), 'outside.html');
    const external = await readFile(linkedPath, 'utf8');
    await writeFile(externalPath, external);
    await rename(linkedPath, originalPath);
    await symlink(externalPath, linkedPath);

    const result = await runCli(['fix', project, '--write', '--json']);
    const report = JSON.parse(result.stdout) as {
      files: Array<{ file: string; changed?: boolean; warnings: number }>;
      items: Array<{ code?: string }>;
    };

    expect(result.code).toBe(0);
    expect(report.files.find(({ file }) => file === 'templates/index.html')).toMatchObject({ changed: false, warnings: 1 });
    expect(report.items.some(({ code }) => code === 'theme-unsafe-target')).toBe(true);
    expect(await readFile(externalPath, 'utf8')).toBe(external);
  });

  it('warns when a theme discovery root is a symlink', async () => {
    const project = await copiedTheme('valid-theme');
    const templates = path.join(project, 'templates');
    const realTemplates = path.join(project, 'templates-original');
    await rename(templates, realTemplates);
    await symlink(realTemplates, templates, 'dir');

    const result = await runCli(['validate', project, '--json']);
    const report = JSON.parse(result.stdout) as {
      files: Array<{ file: string; blocks: number; warnings: number }>;
      items: Array<{ code?: string; reason: string }>;
    };

    expect(result.code).toBe(0);
    expect(report.files.find(({ file }) => file === 'templates/')).toMatchObject({ blocks: 0, warnings: 1 });
    expect(report.items.some(({ code }) => code === 'theme-unsafe-target')).toBe(true);
  });

  it('shifts pattern validation locations back across the preserved PHP header', async () => {
    const project = await copiedTheme('valid-theme');
    const patternPath = path.join(project, 'patterns', 'callout.php');
    const original = await readFile(patternPath, 'utf8');
    const invalid = original.replace('<h2 class=', '<h3 class=');
    await writeFile(patternPath, invalid);
    const headerLength = original.indexOf('<!-- wp:');
    const expectedOffset = invalid.indexOf('<!-- wp:heading');
    const expectedLine = invalid.slice(0, expectedOffset).split(/\r\n|\r|\n/).length;

    const result = await runCli(['validate', project, '--json']);
    const report = JSON.parse(result.stdout) as {
      items: Array<{ block?: string; source?: { path?: string; offset?: number; htmlLine?: number } }>;
    };
    const finding = report.items.find(({ block }) => block === 'core/heading');

    expect(result.code).toBe(1);
    expect(headerLength).toBeGreaterThan(0);
    expect(finding?.source).toMatchObject({ path: patternPath, offset: expectedOffset, htmlLine: expectedLine });
  });
});

async function copiedTheme(name: string): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-'));
  const copy = path.join(parent, name);
  await cp(path.join(fixtureRoot, name), copy, { recursive: true });
  return copy;
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxImport, new URL('../../src/cli.ts', import.meta.url).pathname, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env: process.env,
    });
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
