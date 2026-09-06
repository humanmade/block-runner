#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const manifestPath = resolve(directory, 'inputs.json');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const arguments_ = process.argv.slice(2);
const check = arguments_.includes('--check');
const outputIndex = arguments_.indexOf('--output');
const revisionIndex = arguments_.indexOf('--candidate-revision');

if (check && arguments_.length !== 1) usage();
if (!check && (outputIndex < 0 || revisionIndex < 0 || outputIndex + 1 >= arguments_.length || revisionIndex + 1 >= arguments_.length || arguments_.length !== 4)) usage();

const files = [];
for (const journey of manifest.journeys) {
  for (const input of [journey.source, ...journey.dependencies]) {
    const declaredPath = input.html ?? input.path;
    const source = resolve(directory, declaredPath);
    if (!source.startsWith(`${repository}/`)) throw new Error(`Input escapes the repository: ${declaredPath}`);
    const digest = `sha256:${hash(await readFile(source))}`;
    if (digest !== input.sha256) throw new Error(`${journey.id}: expected ${input.sha256}, got ${digest} for ${declaredPath}`);
    files.push({ journey: journey.id, source, declaredPath, sha256: digest });
  }
}

if (check) {
  console.log(`checked ${files.length} acceptance input file(s)`);
  process.exit(0);
}

const output = resolve(arguments_[outputIndex + 1]);
if (output === repository || output.startsWith(`${repository}/`)) throw new Error('Output must not be inside the repository.');
try {
  await stat(output);
  throw new Error(`Refusing to overwrite existing output: ${output}`);
} catch (error) {
  if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
}

await mkdir(output);
const copied = [];
for (const file of files) {
  const staged = resolve(output, file.journey, relative(repository, file.source));
  await mkdir(dirname(staged), { recursive: true });
  await copyFile(file.source, staged);
  copied.push({
    journey: file.journey,
    source: file.declaredPath,
    staged: relative(output, staged),
    sha256: file.sha256,
  });
}

const receipt = {
  version: 1,
  status: 'staged-not-run',
  candidateRevision: arguments_[revisionIndex + 1],
  inputsManifestSha256: `sha256:${hash(manifestBytes)}`,
  files: copied,
  note: 'Staging preserves reviewed source bytes only. It does not analyse, generate, build, install, or prove a block.',
};
await writeFile(resolve(output, 'input-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`staged ${copied.length} input file(s) in ${output}`);

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function usage() {
  throw new Error('Usage: prepare-inputs.mjs --check | --output <new-directory> --candidate-revision <full-git-sha>');
}
