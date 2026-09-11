#!/usr/bin/env node
/** Classify a complete git name-status diff for the conservative CI routes. */
import { spawnSync } from 'node:child_process';

const DOCUMENTATION_PATHS = new Set(['README.md', 'CHANGELOG.md', 'ERRORS.md', 'DECISIONS.md']);
const SKILL_PREFIX = 'skills/block-runner/';

/**
 * Classify parsed `git diff --name-status --find-renames` entries without reading git.
 * Every path from a rename or deletion is considered, so removed or moved runtime files
 * cannot accidentally select the smaller routes.
 */
export function classifyChanges(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { route: 'full', docs: [], reason: 'empty-diff' };
  }

  const paths = entries.flatMap((entry) => entry.paths ?? []);
  if (paths.length === 0 || paths.some((path) => typeof path !== 'string' || path.length === 0)) {
    return { route: 'full', docs: [], reason: 'unclassified-path' };
  }

  const docs = [...new Set(paths.filter((path) => DOCUMENTATION_PATHS.has(path)
    || (path.startsWith(SKILL_PREFIX) && path.endsWith('.md'))))].sort();
  if (paths.every((path) => DOCUMENTATION_PATHS.has(path))) {
    return { route: 'docs', docs, reason: 'root-documentation-only' };
  }

  if (paths.every((path) => DOCUMENTATION_PATHS.has(path) || path.startsWith(SKILL_PREFIX))
    && paths.some((path) => path.startsWith(SKILL_PREFIX))) {
    return { route: 'skill', docs, reason: 'skill-and-root-documentation-only' };
  }

  return { route: 'full', docs: [], reason: 'runtime-or-unclassified-path' };
}

/** Classify a diff command result while making unavailable input visibly conservative. */
export function classifyDiffResult(result) {
  if (!result?.ok) {
    return { route: 'full', docs: [], reason: 'diff-unavailable', classifierFailed: true };
  }

  try {
    return { ...classifyChanges(parseNameStatus(result.output)), classifierFailed: false };
  } catch (error) {
    return {
      route: 'full',
      docs: [],
      reason: 'diff-parse-failed',
      classifierFailed: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseNameStatus(output) {
  if (typeof output !== 'string') throw new TypeError('Diff output must be a string.');
  if (output === '') return [];

  return output.trimEnd().split('\n').map((line) => {
    const fields = line.split('\t');
    const status = fields.shift();
    if (!status || !/^[ACDMRTUXB]/.test(status)) {
      throw new Error(`Unrecognised name-status entry: ${line}`);
    }
    const expectedPaths = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    if (fields.length !== expectedPaths || fields.some((path) => path.length === 0)) {
      throw new Error(`Malformed name-status entry: ${line}`);
    }
    return { status, paths: fields };
  });
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== '--base' && flag !== '--head') || !value || values.has(flag)) {
      throw new Error('Usage: node scripts/ci-scope.mjs --base <sha> --head <sha>');
    }
    values.set(flag, value);
  }
  if (values.size !== 2) throw new Error('Usage: node scripts/ci-scope.mjs --base <sha> --head <sha>');
  return { base: values.get('--base'), head: values.get('--head') };
}

function main() {
  const { base, head } = readArguments(process.argv.slice(2));
  const diff = spawnSync('git', ['diff', '--name-status', '--find-renames', base, head], { encoding: 'utf8' });
  if (diff.error || diff.status !== 0) {
    const detail = diff.error?.message ?? diff.stderr.trim() ?? `exit ${diff.status}`;
    throw new Error(`Unable to classify ${base}..${head}: ${detail}`);
  }
  const result = classifyDiffResult({ ok: true, output: diff.stdout });
  if (result.classifierFailed) throw new Error(`Unable to classify ${base}..${head}: ${result.error}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
