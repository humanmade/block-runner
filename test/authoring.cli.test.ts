import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashAuthoringPlan } from '../src/authoring/schema.js';

const tsxImport = import.meta.resolve('tsx');
const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

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
    files: [],
    warnings: [],
    ...overrides,
  };
}

describe('author CLI', () => {
  it('does not let direct HTML authoring bypass source confirmation', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-author-cli-'));
    await writeFile(path.join(project, 'design.html'), '<p>Native paragraph</p>');
    const rejected = await runCli(['author', 'design.html', '--name', 'example/notice', '--out-dir', 'generated', '--json'], project);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain('analysis-only');
    await expect(stat(path.join(project, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' });
    const analyzed = await runCli(['author', 'design.html', '--name', 'example/notice', '--json'], project);
    expect(analyzed.code).toBe(0);
    const report = JSON.parse(analyzed.stdout);
    expect(report.package.canonicalPlan.structure[0].block).toBe('core/paragraph');
    expect(report.package.files['index.js']).toContain("import './style.scss'");
    await expect(stat(path.join(project, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('previews without writing and only writes the exact confirmed canonical plan', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-author-cli-'));
    const input = plan();
    await writeFile(path.join(project, 'plan.json'), JSON.stringify(input));

    const preview = await runCli(['author', 'preview', 'plan.json', '--output-dir', 'generated', '--width', '62', '--json'], project);
    expect(preview.code).toBe(0);
    const previewJson = JSON.parse(preview.stdout) as { hash: string; preview: string; noFilesWritten: boolean };
    expect(previewJson.noFilesWritten).toBe(true);
    expect(previewJson.preview).toContain('No files written.');
    expect(previewJson.preview).toContain('block.json [create]');
    expect(previewJson.preview).toContain('block.php [create]');
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
    const result = JSON.parse(written.stdout) as {
      destination: { directory: string };
      delivery: { next: { existingPlugin: string; standalonePlugin: string } };
    };
    expect(result).toMatchObject({
      written: ['block.json', 'index.js', 'edit.js', 'save.js', 'style.scss', 'editor.scss', 'block.php'],
      noFilesWritten: false,
      delivery: {
        status: 'source-delivered',
        buildRuntimeProof: 'not-run',
        next: {
          existingPlugin: expect.stringContaining('plugin preview'),
          standalonePlugin: expect.stringContaining('plugin preview'),
        },
      },
    });
    expect(result.delivery.next.existingPlugin).toBe(
      `npx -y block-runner@${packageVersion} plugin preview ${shellQuote(result.destination.directory)} --host <existing-plugin-root>`,
    );
    expect(result.delivery.next.standalonePlugin).toBe(
      `npx -y block-runner@${packageVersion} plugin preview ${shellQuote(result.destination.directory)} --standalone <retained-plugin-directory>`,
    );
    expect(JSON.parse(await readFile(path.join(project, 'generated', 'block.json'), 'utf8'))).toMatchObject({
      name: 'example/notice',
      title: 'Notice',
    });
  });

  it('rejects approval when the previewed destination fingerprint has changed', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-author-cli-'));
    const destination = path.join(project, 'generated');
    await mkdir(destination);
    await writeFile(path.join(destination, 'block.json'), 'before\n');
    await writeFile(path.join(project, 'plan.json'), JSON.stringify(plan({
      files: [{ path: 'block.json', operation: 'replace' }],
    })));

    const preview = await runCli(['author', 'preview', 'plan.json', '--output-dir', 'generated', '--json'], project);
    expect(preview.code).toBe(0);
    const previewJson = JSON.parse(preview.stdout) as {
      hash: string;
      preview: string;
      touchedFiles: Array<{ path: string; operation: string; exists: boolean }>;
      replacementApprovals: string[];
    };
    const replacement = previewJson.touchedFiles.find((file) => file.operation === 'replace');
    expect(replacement).toMatchObject({ path: expect.stringMatching(/\/generated\/block\.json$/), exists: true });
    expect(previewJson.replacementApprovals).toEqual([replacement!.path]);
    expect(previewJson.preview).toContain(replacement!.path);
    expect(previewJson.preview).toContain('explicit hash-bound replacement approval required');
    expect(previewJson.preview).toContain(`Confirmation SHA-256: ${previewJson.hash}`);
    expect(previewJson.preview.indexOf('Warnings')).toBeLessThan(previewJson.preview.indexOf('Confirmation SHA-256:'));
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

  it('reports source delivery and its next integration commands without claiming proof', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-author-cli-'));
    await writeFile(path.join(project, 'plan.json'), JSON.stringify(plan()));
    const preview = await runCli(['author', 'preview', 'plan.json', '--output-dir', 'generated', '--json'], project);
    const previewJson = JSON.parse(preview.stdout) as { hash: string; destination: { directory: string } };

    const written = await runCli(
      ['author', 'write', 'plan.json', '--confirm', previewJson.hash, '--output-dir', 'generated'],
      project,
    );

    expect(written.code).toBe(0);
    expect(written.stdout).toContain('Source delivery: complete. Build and WordPress runtime proof have not run.');
    expect(written.stdout).toContain(
      `Next (existing plugin): npx -y block-runner@${packageVersion} plugin preview ${shellQuote(previewJson.destination.directory)} --host <existing-plugin-root>`,
    );
    expect(written.stdout).toContain(
      `Next (standalone plugin): npx -y block-runner@${packageVersion} plugin preview ${shellQuote(previewJson.destination.directory)} --standalone <retained-plugin-directory>`,
    );
  });

  it('quotes shell metacharacters in JSON next commands', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'block-runner-author-cli-'));
    const outputDirectory = "generated;$(printf unsafe)`&| ' space";
    await writeFile(path.join(project, 'plan.json'), JSON.stringify(plan()));
    const preview = await runCli(['author', 'preview', 'plan.json', '--output-dir', outputDirectory, '--json'], project);
    const previewJson = JSON.parse(preview.stdout) as { hash: string };
    const written = await runCli(
      ['author', 'write', 'plan.json', '--confirm', previewJson.hash, '--output-dir', outputDirectory, '--json'],
      project,
    );

    expect(written.code).toBe(0);
    const result = JSON.parse(written.stdout) as {
      destination: { directory: string };
      delivery: { next: { existingPlugin: string; standalonePlugin: string } };
    };
    expect(result.delivery.next.existingPlugin).toBe(
      `npx -y block-runner@${packageVersion} plugin preview ${shellQuote(result.destination.directory)} --host <existing-plugin-root>`,
    );
    expect(result.delivery.next.standalonePlugin).toBe(
      `npx -y block-runner@${packageVersion} plugin preview ${shellQuote(result.destination.directory)} --standalone <retained-plugin-directory>`,
    );
  });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
