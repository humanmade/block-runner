import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const tsxImport = import.meta.resolve('tsx');

describe('registered-block workflow', () => {
  it('activates for registered-block work and preserves the preview, confirmation, destination, packaging, and full-proof sequence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-workflow-'));
    const planPath = path.join(root, 'authoring-plan.json');
    const outputDirectory = path.join(root, 'generated', 'feature-grid');
    await writeFile(planPath, JSON.stringify(plan()));

    const authorPreview = await runCli([
      'author', 'preview', 'authoring-plan.json', '--output-dir', outputDirectory, '--json',
    ], root);
    expect(authorPreview.code).toBe(0);
    const preview = JSON.parse(authorPreview.stdout) as { hash: string; preview: string; noFilesWritten: boolean };
    expect(preview.noFilesWritten).toBe(true);
    expect(preview.preview).toContain('Confirmation SHA-256:');
    expect(preview.preview).toContain('No files written.');
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    const authorWrite = await runCli([
      'author', 'write', 'authoring-plan.json', '--output-dir', outputDirectory, '--confirm', preview.hash, '--json',
    ], root);
    expect(authorWrite.code).toBe(0);
    expect(JSON.parse(authorWrite.stdout)).toMatchObject({ command: 'author write', noFilesWritten: false });
    expect(JSON.parse(await readFile(path.join(outputDirectory, 'block.json'), 'utf8'))).toMatchObject({
      name: 'acme/feature-grid',
      title: 'Feature grid',
    });

    const host = await existingPlugin(root);
    const inspect = await runCli(['plugin', 'inspect', host, '--json'], root);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({ kind: 'recognized' });

    const pluginPreview = await runCli(['plugin', 'preview', outputDirectory, '--host', host, '--json'], root);
    expect(pluginPreview.code).toBe(0);
    const packagePlan = JSON.parse(pluginPreview.stdout) as {
      fingerprint: string;
      touchedFiles: Array<{ path: string; operation: string }>;
      noFilesWritten: boolean;
    };
    expect(packagePlan.noFilesWritten).toBe(true);
    const replacement = packagePlan.touchedFiles.find((file) => file.operation === 'modify')?.path;
    expect(replacement).toBeTruthy();

    const pluginWrite = await runCli([
      'plugin', 'write', outputDirectory, '--host', host, '--confirm', packagePlan.fingerprint,
      '--approve-replace', replacement!, '--json',
    ], root);
    expect(pluginWrite.code).toBe(0);
    expect(JSON.parse(pluginWrite.stdout)).toMatchObject({
      delivery: {
        status: 'source-delivered',
        buildRuntimeProof: 'not-run',
        nextCommand: expect.stringContaining('npm run build'),
      },
    });
    await expect(readFile(path.join(host, 'src', 'blocks', 'feature-grid', 'index.js'), 'utf8')).resolves.toContain('registerBlockType');

    const markup = path.join(root, 'feature-grid.blocks.html');
    const fixture = path.join(root, 'feature-grid.proof.json');
    const archive = path.join(root, 'feature-grid.zip');
    const receipts = path.join(root, 'proof');
    await Promise.all([
      writeFile(markup, '<!-- wp:paragraph --><p>Feature grid</p><!-- /wp:paragraph -->'),
      writeFile(archive, 'fixture archive'),
      writeFile(fixture, JSON.stringify({ blockName: 'acme/feature-grid' })),
    ]);
    const proof = await runCli([
      'proof', archive, '--profile', 'full', '--input', planPath, '--markup', markup,
      '--fixture', fixture, '--receipt-dir', receipts, '--no-run', '--json',
    ], root);
    // A no-run full proof deliberately fails closed, but it must produce the immutable receipt
    // that records every runtime/editor/pattern gate as unproven instead of silently succeeding.
    expect(proof.code).toBe(1);
    const proofResult = JSON.parse(proof.stdout) as { receiptReference: { path: string }; profile: { failedGates: Array<{ gate: string }> } };
    expect(proofResult.profile.failedGates.map((gate) => gate.gate)).toContain('pattern_overrides');
    await expect(readFile(path.join(receipts, proofResult.receiptReference.path), 'utf8')).resolves.toContain('block-runner.wordpress-proof');
  }, 30_000);
});

function plan(): Record<string, unknown> {
  return {
    version: 1,
    generatorVersion: '0.9.0-preview.1',
    target: { name: 'acme/feature-grid', title: 'Feature grid' },
    structure: [{ id: 'root', block: 'core/group', children: [{ id: 'heading', block: 'core/heading' }] }],
    fields: [{ id: 'heading', label: 'Heading', mode: 'editable', node: 'heading', attribute: 'content' }],
    locking: { mode: 'contentOnly', move: false, remove: false, insert: false },
    styles: { strategy: 'native', outcomes: [] },
    pattern: { ready: true, overrides: [{ field: 'heading' }] },
    assets: [],
    files: [],
    warnings: [],
  };
}

async function existingPlugin(root: string): Promise<string> {
  const host = path.join(root, 'host-plugin');
  await mkdir(path.join(host, 'src', 'blocks', 'existing'), { recursive: true });
  await Promise.all([
    writeFile(path.join(host, 'package.json'), JSON.stringify({
      devDependencies: { '@wordpress/scripts': '34.2.0' },
      scripts: { build: 'wp-scripts build --source-path src/blocks --output-path build/blocks' },
    })),
    writeFile(path.join(host, 'main.php'), "<?php\nregister_block_type( __DIR__ . '/build/blocks/existing' );\n"),
    writeFile(path.join(host, 'src', 'blocks', 'existing', 'block.json'), JSON.stringify({ name: 'acme/existing' })),
  ]);
  return host;
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
