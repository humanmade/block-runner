#!/usr/bin/env node
/**
 * Collect a WordPress 7.1 native rich-text control used by a narrowly scoped
 * 0.9 editor accessibility exception. The default is Heading for backwards
 * compatibility; pass `--block paragraph` to collect the native Paragraph
 * control as a separate, hash-bound evidence set.
 *
 * This is deliberately a separate control run. It starts the same pinned
 * wp-env, observes the actual core version before and after the browser run,
 * and invokes the production WordPress browser helper without a Block Runner
 * plugin. The output is evidence, not an Axe waiver: release acceptance still
 * validates the retained JSON and its hash before using it.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_BASE_URL = 'http://localhost:8888';
const WP_ENV_CONFIG = path.join(ROOT, 'proof', 'wp-env.json');
const BROWSER_HELPER = path.join(ROOT, 'scripts', 'proof-playwright.mjs');
const EXPECTED_WORDPRESS_VERSION = '7.1';
const CONTROL_CONFIGS = {
  heading: {
    blockName: 'core/heading',
    blockTitle: 'Heading',
    element: 'h2',
    expectedFindings: new Set(['aria-allowed-attr', 'aria-allowed-role']),
  },
  paragraph: {
    blockName: 'core/paragraph',
    blockTitle: 'Paragraph',
    element: 'p',
    // WordPress 7.1's native Paragraph control currently reports only this
    // rule. Keep the set exact so new findings remain release blockers.
    expectedFindings: new Set(['aria-allowed-attr']),
  },
};
const controlKind = valueFor('--block') ?? 'heading';
const control = CONTROL_CONFIGS[controlKind];
if (!control) throw new Error(`--block must be one of: ${Object.keys(CONTROL_CONFIGS).join(', ')}`);
const environmentPrefix = controlKind.toUpperCase();
const outputEnvironmentVariable = `BLOCK_RUNNER_NATIVE_${environmentPrefix}_CONTROL_OUTPUT_DIR`;

const outputDirectory = path.resolve(valueFor('--output-dir')
  ?? process.env[outputEnvironmentVariable]
  ?? path.join(process.cwd(), `native-${controlKind}-control-proof`));
const baseUrl = (process.env.BLOCK_RUNNER_PROOF_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
const keepEnvironment = process.argv.includes('--keep-environment')
  || process.env[`BLOCK_RUNNER_NATIVE_${environmentPrefix}_CONTROL_KEEP`] === '1';
const commandRecords = [];

await mkdir(outputDirectory, { recursive: true });

try {
  const startedAt = new Date().toISOString();
  const start = await runCommand('npx', ['--no-install', 'wp-env', `--config=${WP_ENV_CONFIG}`, 'start'], 'start');
  if (start.exitCode !== 0) throw new Error(`Pinned WordPress 7.1 environment did not start (exit ${start.exitCode}).`);

  const before = await observeVersion('before');
  if (before.version !== EXPECTED_WORDPRESS_VERSION) {
    throw new Error(`Expected WordPress ${EXPECTED_WORDPRESS_VERSION} before the control run, observed ${JSON.stringify(before.version)}.`);
  }

  const browserDirectory = path.join(outputDirectory, 'browser');
  await mkdir(browserDirectory, { recursive: true });
  const fixturePath = path.join(browserDirectory, 'proof.json');
  const rawResultPath = path.join(browserDirectory, 'result.json');
  await writeJson(fixturePath, {
    baseUrl,
    profile: 'full',
    fixture: {
      blockName: control.blockName,
      blockTitle: control.blockTitle,
      editableFields: [{
        path: `control-${controlKind}`,
        surface: 'richText',
        value: `Unwrapped native WordPress ${controlKind}`,
      }],
      accessibility: {
        editorSelector: `[data-type="${control.blockName}"]`,
        manualReview: 'blocked',
      },
    },
  });
  const browser = await runCommand(process.execPath, [
    BROWSER_HELPER,
    '--config', fixturePath,
    '--out', rawResultPath,
  ], 'browser');
  if (browser.exitCode !== 0) throw new Error(`Native ${control.blockTitle} browser helper failed (exit ${browser.exitCode}).`);

  const after = await observeVersion('after');
  if (after.version !== EXPECTED_WORDPRESS_VERSION) {
    throw new Error(`Expected WordPress ${EXPECTED_WORDPRESS_VERSION} after the control run, observed ${JSON.stringify(after.version)}.`);
  }

  const rawBytes = await readFile(rawResultPath);
  const rawResult = JSON.parse(rawBytes.toString('utf8'));
  validateBrowserControl(rawResult, control);
  const controlReceipt = {
    ...rawResult,
    schemaVersion: 1,
    kind: 'block-runner.native-wordpress-control',
    blockName: control.blockName,
    wordpressVersion: EXPECTED_WORDPRESS_VERSION,
    wordpressVersionObservation: {
      command: `npx --no-install wp-env --config=${path.relative(ROOT, WP_ENV_CONFIG)} run cli wp core version`,
      before,
      after,
      baseUrl,
      capturedAt: new Date().toISOString(),
      controlRunWindow: { startedAt, finishedAt: new Date().toISOString() },
    },
    rawBrowserResult: {
      path: path.relative(outputDirectory, rawResultPath).split(path.sep).join('/'),
      sha256: sha256(rawBytes),
    },
  };
  const controlPath = path.join(outputDirectory, `native-${controlKind}-control.json`);
  await writeJson(controlPath, controlReceipt);
  const controlBytes = await readFile(controlPath);
  const controlHash = sha256(controlBytes);
  await writeJson(path.join(outputDirectory, 'manifest.json'), {
    schemaVersion: 1,
    status: 'passed',
    blockName: control.blockName,
    wordpressVersion: EXPECTED_WORDPRESS_VERSION,
    control: {
      path: path.relative(outputDirectory, controlPath).split(path.sep).join('/'),
      sha256: controlHash,
    },
    rawBrowserResult: controlReceipt.rawBrowserResult,
    commands: commandRecords.map(({ label, command, exitCode }) => ({ label, command, exitCode })),
  });
  await writeFile(path.join(outputDirectory, 'github-env.txt'), [
    `BLOCK_RUNNER_NATIVE_${environmentPrefix}_CONTROL_EVIDENCE_PATH=${controlPath}`,
    `BLOCK_RUNNER_NATIVE_${environmentPrefix}_CONTROL_EVIDENCE_SHA256=${controlHash}`,
    `BLOCK_RUNNER_NATIVE_${environmentPrefix}_CONTROL_WORDPRESS_VERSION=${EXPECTED_WORDPRESS_VERSION}`,
  ].join('\n') + '\n', 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    controlPath,
    controlHash,
    wordpressVersion: EXPECTED_WORDPRESS_VERSION,
  }, null, 2)}\n`);
} catch (error) {
  await writeJson(path.join(outputDirectory, 'manifest.json'), {
    schemaVersion: 1,
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    commands: commandRecords,
  });
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (!keepEnvironment) {
    await runCommand('npx', ['--no-install', 'wp-env', `--config=${WP_ENV_CONFIG}`, 'stop'], 'stop');
  }
}

function valueFor(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function runCommand(command, args, label) {
  const record = {
    label,
    command: [command, ...args].join(' '),
    startedAt: new Date().toISOString(),
  };
  try {
    const result = await execFileAsync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 240_000,
    });
    record.exitCode = 0;
    record.stdout = result.stdout ?? '';
    record.stderr = result.stderr ?? '';
  } catch (error) {
    record.exitCode = typeof error?.code === 'number' ? error.code : 1;
    record.stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    record.stderr = typeof error?.stderr === 'string' ? error.stderr : error instanceof Error ? error.message : String(error);
  }
  record.finishedAt = new Date().toISOString();
  commandRecords.push(record);
  await writeJson(path.join(outputDirectory, 'commands', `${label}.json`), record);
  return record;
}

async function observeVersion(label) {
  const result = await runCommand('npx', [
    '--no-install', 'wp-env', `--config=${WP_ENV_CONFIG}`, 'run', 'cli', 'wp', 'core', 'version',
  ], `core-version-${label}`);
  const version = result.stdout.trim();
  return {
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    version,
    capturedAt: new Date().toISOString(),
  };
}

function validateBrowserControl(result, control) {
  const gates = result?.gates;
  const requiredPasses = ['client_registry', 'editor_inserter', 'editor_field_editing', 'editor_save', 'editor_reopen'];
  for (const gate of requiredPasses) {
    if (gates?.[gate]?.status !== 'pass') throw new Error(`Native ${control.blockTitle} control gate ${gate} did not pass.`);
  }
  if (gates.client_registry.details?.block !== control.blockName) {
    throw new Error(`Native ${control.blockTitle} control did not identify the standalone ${control.blockName} block.`);
  }
  const accessibilityEditor = gates.accessibility_editor;
  const violations = accessibilityEditor?.details?.axe?.violations;
  if (accessibilityEditor?.status === 'pass'
    && Array.isArray(violations)
    && violations.length === 0) {
    // A clean upstream control is successful control evidence. It simply does
    // not provide a failure that can be used as an exception basis later.
    return;
  }
  if (accessibilityEditor?.status !== 'fail' || !Array.isArray(violations) || violations.length === 0) {
    throw new Error(`Native ${control.blockTitle} control did not retain a clean Axe result or its expected editor findings.`);
  }
  const ids = new Set();
  for (const violation of violations) {
    if (!control.expectedFindings.has(violation?.id) || !Array.isArray(violation.nodes) || violation.nodes.length === 0) {
      throw new Error(`Native ${control.blockTitle} control retained an unexpected Axe rule or empty node list.`);
    }
    ids.add(violation.id);
    for (const node of violation.nodes) {
      const html = typeof node?.html === 'string' ? node.html : '';
      if (!new RegExp(`^<${control.element}\\b`, 'i').test(html)
        || !/\brole=["']document["']/.test(html)
        || !/\baria-multiline=["']true["']/.test(html)
        || !/\baria-readonly=["']false["']/.test(html)
        || !new RegExp(`\\bdata-type=["']${control.blockName}["']`).test(html)
        || !Array.isArray(node.target) || node.target.length === 0) {
        throw new Error(`Native ${control.blockTitle} control Axe node is not the expected native ${control.element} editor control.`);
      }
    }
  }
  for (const id of control.expectedFindings) if (!ids.has(id)) throw new Error(`Native ${control.blockTitle} control is missing expected Axe finding ${id}.`);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
