#!/usr/bin/env node
/** Install the built tarball as a clean engine-strict consumer, then smoke its CLI. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const packDirectory = mkdtempSync(path.join(tmpdir(), 'block-runner-pack-'));
const consumer = mkdtempSync(path.join(tmpdir(), 'block-runner-consumer-'));

try {
  const packed = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], root);
  const details = JSON.parse(packed.stdout);
  if (!Array.isArray(details) || details.length !== 1 || typeof details[0]?.filename !== 'string') {
    throw new Error('npm pack did not return exactly one tarball.');
  }
  const tarball = path.join(packDirectory, details[0].filename);
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');

  run('npm', ['install', '--engine-strict', '--no-audit', '--no-fund', tarball], consumer);
  const cli = path.join(consumer, 'node_modules', 'block-runner', 'dist', 'cli.js');
  const version = run(process.execPath, [cli, '--version'], consumer).stdout.trim();
  const packageVersion = JSON.parse(readFileSync(path.join(consumer, 'node_modules', 'block-runner', 'package.json'), 'utf8')).version;
  if (version !== packageVersion) throw new Error(`Packed CLI reported ${version}; expected ${packageVersion}.`);

  const conversion = JSON.parse(run(process.execPath, [cli, 'convert', '<p>Node support smoke</p>', '--json'], consumer).stdout);
  if (!conversion.ok) throw new Error('Packed CLI conversion smoke did not succeed.');
  console.log(`Packed engine-strict install and CLI smoke passed on Node ${process.versions.node}.`);
} finally {
  rmSync(packDirectory, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}:\n${result.stderr || result.stdout}`);
  }
  return result;
}
