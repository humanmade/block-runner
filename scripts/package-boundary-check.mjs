/**
 * Exercise the published tarball in fresh consumers. This intentionally uses
 * no source imports after packing: the basic consumer proves the normal
 * conversion/authoring surface, while the second consumer opts into the
 * exact proof packages without downloading Chromium or starting Docker.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROOF_TOOLING = [
  '@wordpress/env',
  '@playwright/test',
  '@wordpress/e2e-test-utils-playwright',
  'axe-core',
  'pixelmatch',
  'pngjs',
];

const packDirectory = mkdtempSync(path.join(tmpdir(), 'block-runner-package-boundary-'));
run('npm', ['pack', '--ignore-scripts', '--pack-destination', packDirectory]);
const tarballs = readdirSync(packDirectory).filter((file) => file.endsWith('.tgz'));
if (tarballs.length !== 1) throw new Error(`Expected one packed artifact, found ${tarballs.length}.`);
const tarball = path.join(packDirectory, tarballs[0]);

const basic = installPacked(tarball, 'basic');
const manifest = basic.require('block-runner/package.json');
const beforeDirectDependencies = {
  ...manifest.dependencies,
  ...Object.fromEntries(PROOF_TOOLING.map((name) => [name, manifest.peerDependencies?.[name]])),
};
const before = installPacked(
  tarball,
  'before-proof-boundary',
  PROOF_TOOLING.map((name) => `${name}@${manifest.peerDependencies?.[name]}`),
);
const installedDependencyInventory = compareInstalledDependencyInventories(
  installedDependencyInventoryFor(before.consumer),
  installedDependencyInventoryFor(basic.consumer),
);
await verifyBasicConsumer(basic);

const proof = installPacked(tarball, 'proof');
await verifyProofConsumer(proof);

console.log(JSON.stringify({
  productionDirectDependencies: {
    before: Object.keys(beforeDirectDependencies).sort(),
    after: Object.keys(manifest.dependencies).sort(),
    removed: Object.keys(beforeDirectDependencies).filter((name) => !manifest.dependencies[name]).sort(),
  },
  installedDependencyInventory,
  basicConsumer: { proofPackages: 'absent', commands: ['convert', 'assemble', 'validate', 'fix', 'author'] },
  proofConsumer: { proofPackages: 'explicitly-pinned', browserDownload: 'not-requested', docker: 'not-started' },
}, null, 2));

function installPacked(tarballPath, kind, additionalPackages = []) {
  const consumer = mkdtempSync(path.join(tmpdir(), `block-runner-${kind}-consumer-`));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath, ...additionalPackages], { cwd: consumer });
  const packageRoot = path.join(consumer, 'node_modules', 'block-runner');
  const cli = path.join(packageRoot, 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error(`Packed CLI is missing for the ${kind} consumer.`);
  return { consumer, packageRoot, cli, require: createRequire(path.join(consumer, 'package.json')) };
}

async function verifyBasicConsumer({ consumer, packageRoot, cli, require }) {
  const manifest = require('block-runner/package.json');
  for (const name of PROOF_TOOLING) {
    if (manifest.dependencies[name]) throw new Error(`Proof tooling remains a production dependency: ${name}`);
    if (manifest.peerDependencies?.[name] !== manifest.devDependencies?.[name]) throw new Error(`Proof peer is not pinned to development tooling: ${name}`);
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) throw new Error(`Proof peer is not optional: ${name}`);
    try {
      require.resolve(`${name}/package.json`);
    } catch {
      continue;
    }
    throw new Error(`Basic consumer unexpectedly installed proof tooling: ${name}`);
  }

  const library = await import(pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href);
  const converted = await library.convert('<p>Packed basic library smoke.</p>');
  if (!converted.ok) throw new Error('Packed library conversion failed.');

  writeFileSync(path.join(consumer, 'basic.html'), '<p>Packed basic CLI smoke.</p>');
  writeFileSync(path.join(consumer, 'basic.blocks.html'), '<!-- wp:paragraph --><p>Packed basic CLI smoke.</p><!-- /wp:paragraph -->');
  writeFileSync(path.join(consumer, 'basic.intent.json'), '{"blocks":[{"block":"core/paragraph","text":"Packed basic CLI smoke."}]}');
  writeFileSync(path.join(consumer, 'proof-fixture.json'), JSON.stringify({ blockName: 'acme/packed-basic' }));
  writeFileSync(path.join(consumer, 'proof-plugin.zip'), 'not-a-real-zip');

  run(process.execPath, [cli, 'convert', 'basic.html'], { cwd: consumer });
  run(process.execPath, [cli, 'assemble', 'basic.intent.json'], { cwd: consumer });
  run(process.execPath, [cli, 'validate', 'basic.blocks.html'], { cwd: consumer });
  run(process.execPath, [cli, 'fix', 'basic.blocks.html'], { cwd: consumer });
  const authoring = JSON.parse(run(process.execPath, [cli, 'author', 'basic.html', '--name', 'acme/packed-basic', '--json'], { cwd: consumer }).stdout);
  if (!authoring.ok) throw new Error('Packed deterministic authoring failed.');

  const blocked = run(process.execPath, [
    cli, 'proof', 'proof-plugin.zip', '--profile', 'runtime', '--fixture', 'proof-fixture.json',
    '--markup', 'basic.blocks.html', '--input', 'basic.html', '--no-run',
  ], { cwd: consumer, expectedStatus: 1 });
  const expectedCommand = proofToolingInstallCommand(manifest, 'runtime');
  if (!blocked.stdout.includes(expectedCommand) || !blocked.stdout.includes('No tooling was downloaded or started.')) {
    throw new Error(`Normal unavailable-proof output did not provide the required setup instruction: ${blocked.stdout}`);
  }
}

async function verifyProofConsumer({ consumer, packageRoot, cli, require }) {
  const manifest = require('block-runner/package.json');
  const pins = Object.entries(manifest.peerDependencies ?? {}).map(([name, version]) => `${name}@${version}`);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', '--save-exact', ...pins], { cwd: consumer });
  for (const name of PROOF_TOOLING) {
    const expected = manifest.peerDependencies[name];
    const installed = require(`${name}/package.json`).version;
    if (installed !== expected) throw new Error(`Proof tooling pin mismatch for ${name}: expected ${expected}, got ${installed}`);
  }
  const pinSnapshot = JSON.parse(readFileSync(path.join(packageRoot, 'proof', 'dependency-pins.json'), 'utf8'));
  if (!pinSnapshot.packages?.['node_modules/@wordpress/env']?.integrity) {
    throw new Error('Packed proof dependency integrity snapshot is missing @wordpress/env.');
  }
  if (existsSync(path.join(consumer, 'node_modules', 'playwright-core', '.local-browsers'))) {
    throw new Error('The proof-enabled package check unexpectedly downloaded Chromium.');
  }

  writeFileSync(path.join(consumer, 'proof-input.html'), '<p>proof input</p>');
  writeFileSync(path.join(consumer, 'proof-markup.html'), '<!-- wp:paragraph --><p>proof input</p><!-- /wp:paragraph -->');
  writeFileSync(path.join(consumer, 'proof-fixture.json'), JSON.stringify({ blockName: 'acme/packed-proof' }));
  writeFileSync(path.join(consumer, 'proof-plugin.zip'), 'not-a-real-zip');
  const noRun = run(process.execPath, [
    cli, 'proof', 'proof-plugin.zip', '--profile', 'runtime', '--fixture', 'proof-fixture.json',
    '--markup', 'proof-markup.html', '--input', 'proof-input.html', '--no-run', '--json',
  ], { cwd: consumer, expectedStatus: 1 });
  const receipt = JSON.parse(noRun.stdout);
  const reasons = receipt.profile.failedGates.map((gate) => gate.reason ?? '').join(' ');
  if (!reasons.includes('Proof execution was disabled.') || reasons.includes('optional tooling that is unavailable')) {
    throw new Error(`Explicit proof tooling did not reach the no-run receipt path: ${reasons}`);
  }

  // The packages above are installed with scripts disabled, so this isolated
  // cache guarantees that Chromium is absent even on a host with a browser
  // cache. The packaged CLI must explain the manual browser setup before it
  // probes Docker or wp-env.
  const emptyBrowserCache = mkdtempSync(path.join(consumer, 'empty-playwright-browsers-'));
  const browserBlocked = run(process.execPath, [
    cli, 'proof', 'proof-plugin.zip', '--profile', 'runtime', '--fixture', 'proof-fixture.json',
    '--markup', 'proof-markup.html', '--input', 'proof-input.html',
  ], {
    cwd: consumer,
    expectedStatus: 1,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: emptyBrowserCache },
  });
  const browserInstallCommand = 'npx --no-install playwright install chromium';
  if (!browserBlocked.stdout.includes(browserInstallCommand) || !browserBlocked.stdout.includes('Docker was not started.')) {
    throw new Error(`Missing Chromium did not provide the explicit browser setup instruction: ${browserBlocked.stdout}`);
  }
  if (browserBlocked.stderr.includes('docker-info started') || browserBlocked.stderr.includes('wp-env-start started')) {
    throw new Error(`Missing Chromium unexpectedly started Docker or wp-env: ${browserBlocked.stderr}`);
  }
}

function installedDependencyInventoryFor(consumer) {
  const lock = JSON.parse(readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'));
  const inventory = new Set();
  for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
    const name = packageNameAt(location);
    if (name && typeof metadata?.version === 'string') inventory.add(`${name}@${metadata.version}`);
  }
  return [...inventory].sort();
}

function packageNameAt(location) {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(location);
  return match?.[1];
}

function compareInstalledDependencyInventories(before, after) {
  const beforeSet = new Set(before);
  const unexpectedAfter = after.filter((entry) => !beforeSet.has(entry));
  if (unexpectedAfter.length > 0) {
    throw new Error(`Basic installed dependency inventory introduced packages absent from the pre-boundary inventory: ${unexpectedAfter.join(', ')}`);
  }
  const removed = before.filter((entry) => !after.includes(entry));
  if (after.length >= before.length || removed.length === 0) {
    throw new Error('Basic installed dependency inventory was not reduced from the pre-boundary inventory.');
  }
  const missingProofPackages = PROOF_TOOLING.filter((name) => !removed.some((entry) => entry.startsWith(`${name}@`)));
  if (missingProofPackages.length > 0) {
    throw new Error(`Installed dependency inventory retained proof packages after the boundary: ${missingProofPackages.join(', ')}`);
  }
  const transitiveRemoved = removed.filter((entry) => !PROOF_TOOLING.some((name) => entry.startsWith(`${name}@`)));
  if (transitiveRemoved.length === 0) {
    throw new Error('Installed dependency inventory did not show a transitive dependency-tree reduction.');
  }
  return { before, after, removed, transitiveRemoved };
}

function proofToolingInstallCommand(manifest, profile) {
  const required = profile === 'full' ? PROOF_TOOLING : PROOF_TOOLING.slice(0, 4);
  return `npm install --save-dev --save-exact ${required.map((name) => `${name}@${manifest.peerDependencies?.[name]}`).join(' ')}`;
}

function run(command, args, { cwd = ROOT, expectedStatus = 0, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== expectedStatus) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? 'unknown'}; expected ${expectedStatus}.`);
  }
  return result;
}
