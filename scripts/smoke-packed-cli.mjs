#!/usr/bin/env node
/** Install the built tarball as a clean engine-strict consumer, then smoke its CLI and library. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const packDirectory = mkdtempSync(path.join(tmpdir(), 'block-runner-pack-'));
const consumer = mkdtempSync(path.join(tmpdir(), 'block-runner-consumer-'));

try {
  const packed = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], root);
  const details = parsePackJson(packed.stdout);
  if (!Array.isArray(details) || details.length !== 1 || typeof details[0]?.filename !== 'string') {
    throw new Error('npm pack did not return exactly one tarball.');
  }
  const tarball = path.join(packDirectory, details[0].filename);
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');

  run('npm', ['install', '--engine-strict', '--no-audit', '--no-fund', tarball], consumer);
  const cli = path.join(consumer, 'node_modules', 'block-runner', 'dist', 'cli.js');
  const version = run(process.execPath, [cli, '--version'], consumer).stdout.trim();
  const packageVersion = JSON.parse(readFileSync(path.join(consumer, 'node_modules', 'block-runner', 'package.json'), 'utf8')).version;
  if (version !== packageVersion) throw new Error('Packed CLI reported ' + version + '; expected ' + packageVersion + '.');

  const conversion = JSON.parse(run(process.execPath, [cli, 'convert', '<p>Node support smoke</p>', '--json'], consumer).stdout);
  if (!conversion.ok) throw new Error('Packed CLI conversion smoke did not succeed.');

  const typecheck = path.join(root, 'node_modules', '.bin', 'tsc');
  writeFileSync(path.join(consumer, 'library-smoke.mts'), [
    "import { AuthoringGenerationError, convert, type ConvertOptions } from 'block-runner';",
    'const convertApi: typeof convert = convert;',
    'let options: ConvertOptions | undefined;',
    'let error: AuthoringGenerationError | undefined;',
    'void convertApi; void options; void error;',
    '',
  ].join('\n'));
  run(typecheck, ['--strict', '--noEmit', '--skipLibCheck', '--typeRoots', path.join(root, 'node_modules', '@types'), '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', 'library-smoke.mts'], consumer);

  run(process.execPath, ['--input-type=module', '--eval', [
    "const api = await import('block-runner');",
    "if (typeof api.convert !== 'function' || typeof api.AuthoringGenerationError !== 'function') throw new Error('missing public library exports');",
  ].join('\n')], consumer);

  console.log('Packed engine-strict install, CLI, and typed library smoke passed on Node ' + process.versions.node + '.');
} finally {
  trash(packDirectory);
  trash(consumer);
}

function parsePackJson(stdout) {
  const start = stdout.indexOf('[\n');
  if (start < 0) throw new Error('npm pack did not return JSON output:\n' + stdout);
  return JSON.parse(stdout.slice(start));
}

function trash(target) {
  // The smoke directories are unique temporary paths, but retain them if this host lacks trash.
  spawnSync('trash', [target], { encoding: 'utf8' });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed with exit ' + result.status + ':\n' + (result.stderr || result.stdout));
  }
  return result;
}
