import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixtureRoot = fileURLToPath(new URL('../fixtures/themes/', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const schemaPath = fileURLToPath(new URL('../../src/theme/vendor/wordpress-theme.schema.7.1.json', import.meta.url));
const provenancePath = `${schemaPath.slice(0, -5)}.provenance.json`;

describe('theme.json schema validation', () => {
  it('accepts the valid fixture, reports alternate schema metadata as info, and uses the local pin', async () => {
    const project = await copiedTheme('valid-theme');
    const themeJsonPath = path.join(project, 'theme.json');
    const themeJson = JSON.parse(await readFile(themeJsonPath, 'utf8')) as Record<string, unknown>;
    themeJson.$schema = 'https://offline.invalid/other-theme-schema.json';
    await writeFile(themeJsonPath, `${JSON.stringify(themeJson, null, 2)}\n`);
    const direct = await runCli(['validate', themeJsonPath, '--json']);
    const directReport = JSON.parse(direct.stdout) as {
      ok: boolean;
      items: Array<{ code?: string; status: string; severity?: string; reason: string }>;
    };
    expect(direct.code).toBe(0);
    expect(directReport.ok).toBe(true);
    expect(directReport.items).toEqual([expect.objectContaining({
      code: 'theme-json-schema-version', status: 'warning', severity: 'info',
      reason: expect.stringContaining('validation uses the pinned WordPress 7.1 schema'),
    })]);

    const schema = await readFile(schemaPath);
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as Record<string, unknown>;
    expect(createHash('sha256').update(schema).digest('hex')).toBe('718d6e0109a06933eea29d8261ebdf5fcfabe4926bcfb30c44e2e16a3a535f9a');
    expect(provenance).toMatchObject({
      targetWordPress: '7.1',
      schemaUrl: 'https://schemas.wp.org/wp/7.1/theme.json',
      retrieved: '2026-10-12',
      sha256: '718d6e0109a06933eea29d8261ebdf5fcfabe4926bcfb30c44e2e16a3a535f9a',
    });
  });

  it('reports both seeded schema errors and does not rewrite theme.json during fix --write', async () => {
    const project = await copiedTheme('broken-theme');
    const themeJsonPath = path.join(project, 'theme.json');
    const original = await readFile(themeJsonPath, 'utf8');
    const validation = await runCli(['validate', project, '--json']);
    const report = JSON.parse(validation.stdout) as {
      ok: boolean;
      files: Array<{ file: string; invalid: number }>;
      items: Array<{ code?: string; source?: { path?: string; selector?: string }; details?: { pointer?: string } }>;
    };
    const errors = report.items.filter(({ code }) => code === 'theme-json-schema');

    expect(validation.code).toBe(1);
    expect(report.files.find(({ file }) => file === 'theme.json')).toMatchObject({ invalid: 2 });
    expect(errors.map(({ source }) => source?.selector).sort()).toEqual(['/settings/layout/contentSize', '/unexpectedKey']);
    expect(errors.every(({ source }) => source?.path === themeJsonPath)).toBe(true);
    expect(errors.map(({ details }) => details?.pointer).sort()).toEqual(['/settings/layout/contentSize', '/unexpectedKey']);

    const text = await runCli(['validate', themeJsonPath]);
    expect(text.stdout).toContain('invalid');
    expect(text.stdout).not.toContain('warning:');

    const fix = await runCli(['fix', project, '--write', '--json']);
    expect(fix.code).toBe(1);
    expect(await readFile(themeJsonPath, 'utf8')).toBe(original);
  });

  it('reports malformed theme.json as one schema error without throwing', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-json-'));
    const themeJsonPath = path.join(parent, 'theme.json');
    await cp(path.join(fixtureRoot, 'broken-theme-malformed', 'theme.json'), themeJsonPath);

    const result = await runCli(['validate', themeJsonPath, '--json']);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { invalid: number };
      items: Array<{ code?: string; status: string; reason: string; source?: { path?: string } }>;
    };
    expect(result.code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.summary.invalid).toBe(1);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      code: 'theme-json-schema', status: 'invalid', source: { path: themeJsonPath },
      reason: expect.stringContaining('theme.json is malformed JSON'),
    });
  });
});

async function copiedTheme(name: string): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-json-'));
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
