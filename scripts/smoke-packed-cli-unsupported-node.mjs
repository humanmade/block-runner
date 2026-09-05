#!/usr/bin/env node
/**
 * Exercise the published CLI entry point on the last unsupported Node 20
 * patch. The packed artifact, rather than a source-level helper, must reject
 * it before any production dependency gets a chance to load.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const unsupportedNode = '20.18.1';
const expectedMessage = `block-runner requires Node.js ^20.19.0 || ^22.13.0 || >=24.0.0; found v${unsupportedNode}.`;
const root = path.resolve(new URL('..', import.meta.url).pathname);
const packDirectory = mkdtempSync(path.join(tmpdir(), 'block-runner-pack-'));
const consumer = mkdtempSync(path.join(tmpdir(), 'block-runner-consumer-'));

try {
  const packed = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], root);
  const details = parsePackJson(packed.stdout);
  if (!Array.isArray(details) || details.length !== 1 || typeof details[0]?.filename !== 'string') {
    throw new Error('npm pack did not return exactly one tarball.');
  }

  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');
  const tarball = path.join(packDirectory, details[0].filename);
  run('npm', ['install', '--engine-strict', '--no-audit', '--no-fund', tarball], consumer);

  const cli = path.join(consumer, 'node_modules', 'block-runner', 'dist', 'cli.js');
  const result = spawnSync('npx', ['--yes', `--package=node@${unsupportedNode}`, 'node', cli, '--version'], {
    cwd: consumer,
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0 || !output.includes(expectedMessage)) {
    throw new Error(`Packed CLI did not reject Node ${unsupportedNode} before dependency loading:\n${output}`);
  }

  console.log(`Packed CLI rejected unsupported Node ${unsupportedNode} before dependency loading.`);
} finally {
  trash(packDirectory);
  trash(consumer);
}

function parsePackJson(stdout) {
  const start = stdout.indexOf('[\n');
  if (start < 0) throw new Error(`npm pack did not return JSON output:\n${stdout}`);
  return JSON.parse(stdout.slice(start));
}

function trash(target) {
  // These are unique temporary paths; retain them if this host lacks trash.
  spawnSync('trash', [target], { encoding: 'utf8' });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}:\n${result.stderr || result.stdout}`);
  }
  return result;
}
