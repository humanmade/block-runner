import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseThemeJsonSettings } from '../../src/tokens/resolver.js';

// Seeded faults in broken-theme include unresolved part, pattern and color-preset references.
const fixtureRoot = fileURLToPath(new URL('../fixtures/themes/', import.meta.url));
const tsxImport = import.meta.resolve('tsx');

describe('theme folder references', () => {
  it('accepts declared presets, existing parts, and a pattern slug from a copied valid fixture', async () => {
    const project = await copiedTheme('valid-theme');
    const template = path.join(project, 'templates', 'index.html');
    await writeFile(template, `${await readFile(template, 'utf8')}\n<!-- wp:pattern {"slug":"fixture/callout"} /-->\n`);

    const result = await runCli(['validate', project, '--json']);
    const report = JSON.parse(result.stdout) as { ok: boolean; items: Array<{ code?: string }> };
    expect(result.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.items.some(({ code }) => ['unresolved-template-part', 'unresolved-pattern', 'undeclared-preset'].includes(code ?? ''))).toBe(false);

    const markup = await readFile(template, 'utf8');
    await writeFile(template, markup.replace('"padding":{"top":"1rem"}', '"padding":{"top":"var:preset|spacing|missing-space"}'));
    const unresolvedStyle = await runCli(['validate', project, '--json']);
    const styleReport = JSON.parse(unresolvedStyle.stdout) as {
      items: Array<{ code?: string; details?: { kind?: string; slug?: string } }>;
    };
    expect(styleReport.items).toContainEqual(expect.objectContaining({
      code: 'undeclared-preset',
      details: expect.objectContaining({ kind: 'spacing', slug: 'missing-space' }),
    }));
  });

  it('reports each seeded missing reference at its file and block path', async () => {
    const project = await copiedTheme('broken-theme');
    const result = await runCli(['validate', project, '--json']);
    const report = JSON.parse(result.stdout) as {
      items: Array<{
        code?: string;
        block?: string;
        source?: { path?: string };
        details?: { blockPath?: string; slug?: string };
      }>;
    };
    const references = report.items.filter(({ code }) =>
      ['unresolved-template-part', 'unresolved-pattern', 'undeclared-preset'].includes(code ?? ''));

    expect(references.map(({ code }) => code).sort()).toEqual([
      'undeclared-preset', 'unresolved-pattern', 'unresolved-template-part',
    ]);
    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unresolved-template-part', block: 'core/template-part',
        source: { path: path.join(project, 'templates', 'index.html') },
        details: expect.objectContaining({ blockPath: 'blocks[0]', slug: 'missing-part' }),
      }),
      expect.objectContaining({
        code: 'unresolved-pattern', block: 'core/pattern',
        source: { path: path.join(project, 'templates', 'index.html') },
        details: expect.objectContaining({ blockPath: 'blocks[1].innerBlocks[0]', slug: 'fixture/missing-pattern' }),
      }),
      expect.objectContaining({
        code: 'undeclared-preset', block: 'core/group',
        source: { path: path.join(project, 'templates', 'index.html') },
        details: expect.objectContaining({ blockPath: 'blocks[1]', kind: 'color', slug: 'missing-preset' }),
      }),
    ]));
  });

  it('skips enabled core palette defaults and reports a mismatched template-part theme', async () => {
    const project = await copiedTheme('valid-theme');
    const themeJsonPath = path.join(project, 'theme.json');
    const themeJson = JSON.parse(await readFile(themeJsonPath, 'utf8')) as {
      settings: { color: { defaultPalette: boolean } };
      templateParts: Array<{ name: string; area: string; title: string }>;
    };
    themeJson.settings.color.defaultPalette = true;
    themeJson.templateParts.push({ name: 'missing-entry', area: 'uncategorized', title: 'Missing entry' });
    await writeFile(themeJsonPath, `${JSON.stringify(themeJson, null, 2)}\n`);

    const template = path.join(project, 'templates', 'index.html');
    const markup = (await readFile(template, 'utf8'))
      .replace('{"slug":"header"}', `{"slug":"header","theme":"${path.basename(project)}"}`)
      .replace('{"slug":"footer"}', '{"slug":"footer","theme":"another-theme"}');
    await writeFile(template, markup);

    const result = await runCli(['validate', project, '--json']);
    const report = JSON.parse(result.stdout) as {
      items: Array<{ code?: string; severity?: string; source?: { path?: string }; details?: { kind?: string } }>;
    };
    const references = report.items.filter(({ code }) =>
      ['preset-check-skipped', 'undeclared-preset', 'unresolved-template-part'].includes(code ?? ''));

    expect(result.code).toBe(0);
    expect(references.some(({ code, severity, details }) =>
      code === 'preset-check-skipped' && severity === 'info' && details?.kind === 'color')).toBe(true);
    expect(references.some(({ code }) => code === 'undeclared-preset')).toBe(false);
    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unresolved-template-part',
        source: { path: path.join(project, 'templates', 'index.html') },
      }),
      expect.objectContaining({
        code: 'unresolved-template-part',
        source: { path: themeJsonPath },
      }),
    ]));
    expect(references.filter(({ code }) => code === 'unresolved-template-part')).toHaveLength(2);
  });

  it('parses gradient presets and ignores malformed preset-array shapes', () => {
    const tokens = parseThemeJsonSettings({
      color: { gradients: [{ slug: 'sunrise', gradient: 'linear-gradient(red, blue)' }] },
    });
    expect(tokens.gradients).toEqual({ sunrise: 'linear-gradient(red, blue)' });
  });

  it('honors config-file strictness before rewriting a missing-reference file', async () => {
    const project = await copiedTheme('valid-theme');
    const config = path.join(path.dirname(project), 'strict.json');
    await writeFile(config, JSON.stringify({ strict: true }));
    const template = path.join(project, 'templates', 'index.html');
    const original = `\n${(await readFile(template, 'utf8')).replace(
      '{"slug":"footer"}', '{"slug":"footer","theme":"another-theme"}',
    )}`;
    await writeFile(template, original);

    const validation = await runCli(['validate', project, '--config', config, '--json']);
    const fix = await runCli(['fix', project, '--write', '--config', config, '--json']);
    expect(validation.code).toBe(1);
    expect(fix.code).toBe(1);
    expect(JSON.parse(fix.stdout).items).toContainEqual(expect.objectContaining({ code: 'unresolved-template-part' }));
    expect(await readFile(template, 'utf8')).toBe(original);
  });

  it('accepts block-scoped presets without exposing them to unrelated blocks', async () => {
    const project = await copiedTheme('valid-theme');
    const themeJsonPath = path.join(project, 'theme.json');
    const themeJson = JSON.parse(await readFile(themeJsonPath, 'utf8'));
    themeJson.settings.blocks = {
      'core/group': { color: { defaultPalette: false, palette: [{ slug: 'block-only', name: 'Block Only', color: '#eeeeee' }] } },
      'core/paragraph': { color: { defaultPalette: false } },
    };
    await writeFile(themeJsonPath, JSON.stringify(themeJson));
    const template = path.join(project, 'templates', 'index.html');
    const markup = (await readFile(template, 'utf8'))
      .replace('"backgroundColor":"base"', '"backgroundColor":"block-only"')
      .replace('has-base-background-color', 'has-block-only-background-color');
    await writeFile(template, markup);
    const valid = await runCli(['validate', project, '--strict', '--json']);
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout).items.some((item: { code?: string }) => item.code === 'undeclared-preset')).toBe(false);

    // A block override disables defaults even when the global setting enables them.
    themeJson.settings.color.defaultPalette = true;
    await writeFile(themeJsonPath, JSON.stringify(themeJson));
    await writeFile(template, markup.replace('"textColor":"ink"', '"textColor":"block-only"').replace('has-ink-color', 'has-block-only-color'));
    const invalid = await runCli(['validate', project, '--strict', '--json']);
    expect(invalid.code).toBe(1);
    const findings = JSON.parse(invalid.stdout).items.filter((item: { code?: string }) => item.code === 'undeclared-preset');
    expect(findings).toEqual([expect.objectContaining({ block: 'core/paragraph', details: expect.objectContaining({ slug: 'block-only' }) })]);
  });
});

async function copiedTheme(name: string): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'block-runner-theme-references-'));
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
