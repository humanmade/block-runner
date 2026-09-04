/**
 * Receipt-backed release-candidate evidence runner.
 *
 * Each command writes immutable stdout/stderr artifacts. ZIP activation is run
 * through a no-shell WordPress 7.1 fixture executable and additionally checks
 * the generated ZIP, activation result, block registration, and retained logs.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const selected = valueFor('--matrix') ?? 'full-release-matrix';
const requestedReceipt = valueFor('--receipt');
const startedAt = new Date().toISOString();
const startedMs = performance.now();
const rows = [];
let packed;
let pluginZip;
let activation;

const allowed = new Set(['full-release-matrix', 'package-packed', 'skill-validate', 'skill-project-install', 'skill-user-install', 'zip-activation']);
if (!allowed.has(selected)) throw new Error(`unknown --matrix value ${JSON.stringify(selected)}`);

const receiptFile = requestedReceipt
  ? path.resolve(ROOT, requestedReceipt)
  : path.join(mkdtempSync(path.join(tmpdir(), 'block-runner-release-receipt-')), 'receipt.json');
const evidenceDirectory = `${receiptFile}.artifacts`;
if (requestedReceipt && existsSync(receiptFile)) throw new Error(`refusing to overwrite immutable release receipt: ${receiptFile}`);
if (existsSync(evidenceDirectory)) throw new Error(`refusing to overwrite immutable release evidence: ${evidenceDirectory}`);
mkdirSync(evidenceDirectory, { recursive: true });

try {
  if (selected === 'full-release-matrix') {
    runRow('candidate-verify', 'npm', ['run', 'verify']);
    runRow('authoring-wordpress-71-proof', 'npm', ['run', 'authoring:prove']);
  }
  if (selected === 'full-release-matrix' || selected === 'package-packed') {
    packed = packCandidate();
    if (packed) installPackedCandidate(packed);
  }
  if (selected === 'full-release-matrix' || selected === 'skill-validate') validateCanonicalSkill();
  if (selected === 'full-release-matrix' || selected === 'skill-project-install') {
    const candidate = packed ?? packCandidate();
    if (candidate) installProjectSkill(candidate);
  }
  if (selected === 'full-release-matrix' || selected === 'skill-user-install') {
    const candidate = packed ?? packCandidate();
    if (candidate) installUserSkill(candidate);
  }
  if (selected === 'full-release-matrix' || selected === 'zip-activation') activation = activateGeneratedPluginZip();
} catch (error) {
  rows.push({
    id: 'release-runner', status: 'engine_error', command: 'release-check internal orchestration', elapsedMs: 0,
    detail: error instanceof Error ? error.message : String(error), artifacts: retainLogs('release-runner', '', error instanceof Error ? error.stack ?? error.message : String(error)),
  });
}

const receipt = buildReceipt();
const schemaFailures = validateReleaseReceipt(receipt);
if (schemaFailures.length) {
  receipt.status = 'engine_error';
  receipt.measurement.engineError = `release receipt schema validation failed: ${schemaFailures.join('; ')}`;
}
const rowResults = path.join(evidenceDirectory, 'row-results.json');
writeFileSync(rowResults, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
receipt.artifacts.retained.push(relativeArtifact(rowResults));
writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (receipt.status !== 'passed') process.exitCode = 1;

function valueFor(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function hash(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function hashFile(file) { return hash(readFileSync(file)); }
function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  });
}
function treeHash(directory, include = () => true) {
  const files = filesBelow(directory).map((file) => path.relative(directory, file).split(path.sep).join('/')).filter(include).sort()
    .map((relative) => ({ path: relative, sha256: hashFile(path.join(directory, relative)).replace(/^sha256:/, '') }));
  return hash(canonicalJson(files));
}
function relativeArtifact(file) { return path.relative(path.dirname(receiptFile), file).split(path.sep).join('/'); }
function retainLogs(id, stdout, stderr) {
  const logs = path.join(evidenceDirectory, 'logs');
  const stdoutFile = path.join(logs, `${id}.stdout.log`);
  const stderrFile = path.join(logs, `${id}.stderr.log`);
  mkdirSync(logs, { recursive: true });
  writeFileSync(stdoutFile, stdout ?? '', 'utf8');
  writeFileSync(stderrFile, stderr ?? '', 'utf8');
  return { stdout: { path: relativeArtifact(stdoutFile), sha256: hashFile(stdoutFile) }, stderr: { path: relativeArtifact(stderrFile), sha256: hashFile(stderrFile) } };
}

function runRow(id, command, args, options = {}) {
  const start = performance.now();
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', env: process.env, ...options });
  const row = {
    id, status: result.error ? 'engine_error' : result.status === 0 ? 'passed' : 'failed', command: [command, ...args].join(' '),
    elapsedMs: Math.round(performance.now() - start), detail: result.error?.message ?? (result.status === 0 ? undefined : `exit ${result.status ?? 'unknown'}`),
    artifacts: retainLogs(id, result.stdout ?? '', result.stderr ?? result.error?.message ?? ''),
  };
  rows.push(row);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return row;
}
function blockedRow(id, command, detail) {
  rows.push({ id, status: 'blocked', command, elapsedMs: 0, detail, artifacts: retainLogs(id, '', detail) });
  return undefined;
}

function packCandidate() {
  const directory = mkdtempSync(path.join(tmpdir(), 'block-runner-rc-pack-'));
  if (runRow('candidate-package-dry-run', 'npm', ['run', 'pack:check']).status !== 'passed') return undefined;
  const row = runRow('candidate-package-artifact', 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]);
  if (row.status !== 'passed') return undefined;
  const tarballs = filesBelow(directory).filter((file) => file.endsWith('.tgz'));
  if (tarballs.length !== 1) { row.status = 'failed'; row.detail = `expected exactly one npm tarball, found ${tarballs.length}`; return undefined; }
  const retained = path.join(evidenceDirectory, 'artifacts', path.basename(tarballs[0]));
  mkdirSync(path.dirname(retained), { recursive: true });
  copyFileSync(tarballs[0], retained);
  row.artifact = { path: relativeArtifact(retained), sha256: hashFile(retained) };
  return { tarball: tarballs[0], sha256: row.artifact.sha256 };
}
function installPackedCandidate(candidate) {
  const consumer = mkdtempSync(path.join(tmpdir(), 'block-runner-rc-consumer-'));
  const row = runRow('packed-candidate-smoke', 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', candidate.tarball], { cwd: consumer });
  const cli = path.join(consumer, 'node_modules', 'block-runner', 'dist', 'cli.js');
  if (row.status === 'passed' && !existsSync(cli)) { row.status = 'failed'; row.detail = `packed CLI missing: ${cli}`; }
  return { consumer, cli };
}
function validateCanonicalSkill() {
  runRow('canonical-skill-validation', process.execPath, [path.join(ROOT, 'dist', 'cli.js'), 'skill', '--install', '--dry-run', '--dir', mkdtempSync(path.join(tmpdir(), 'block-runner-skill-validate-'))]);
}
function installProjectSkill(candidate) {
  const { consumer, cli } = installPackedCandidate(candidate);
  const project = path.join(consumer, 'project'); mkdirSync(project);
  const row = runRow('project-skill-installer-smoke', process.execPath, [cli, 'skill', '--install'], { cwd: project });
  if (row.status === 'passed') for (const destination of [path.join(project, '.agents', 'skills', 'block-runner', '.block-runner-install.json'), path.join(project, '.claude', 'skills', 'block-runner', '.block-runner-install.json')]) {
    if (!existsSync(destination)) { row.status = 'failed'; row.detail = `project skill installer did not create ${destination}`; }
  }
}
function installUserSkill(candidate) {
  const { consumer, cli } = installPackedCandidate(candidate);
  const home = path.join(consumer, 'home'); const project = path.join(consumer, 'project'); mkdirSync(home); mkdirSync(project);
  const row = runRow('user-skill-installer-smoke', process.execPath, [cli, 'skill', '--install', '--scope', 'user', '--target', 'agents'], { cwd: project, env: { ...process.env, HOME: home } });
  const manifest = path.join(home, '.agents', 'skills', 'block-runner', '.block-runner-install.json');
  if (row.status === 'passed' && !existsSync(manifest)) { row.status = 'failed'; row.detail = `user skill installer did not create ${manifest}`; }
}

function createGeneratedPluginZip() {
  const root = mkdtempSync(path.join(tmpdir(), 'block-runner-wp-plugin-'));
  const plugin = path.join(root, 'block-runner-release-candidate'); const build = path.join(plugin, 'build'); mkdirSync(build, { recursive: true });
  writeFileSync(path.join(plugin, 'block-runner-release-candidate.php'), "<?php\n/** Plugin Name: Block Runner release candidate */\nadd_action( 'init', static function () { register_block_type( __DIR__ ); } );\n", 'utf8');
  writeFileSync(path.join(plugin, 'block.json'), `${JSON.stringify({ $schema: 'https://schemas.wp.org/trunk/block.json', apiVersion: 3, name: 'block-runner/release-candidate', title: 'Block Runner release candidate', category: 'widgets', editorScript: 'file:./build/index.js', attributes: {} }, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(build, 'index.js'), "(function(blocks,element){blocks.registerBlockType('block-runner/release-candidate',{edit:function(){return element.createElement('p',{},'Block Runner release candidate');},save:function(){return element.createElement('p',{},'Block Runner release candidate');}});})(window.wp.blocks,window.wp.element);\n", 'utf8');
  const zip = path.join(root, 'block-runner-release-candidate.zip');
  const result = spawnSync('zip', ['-qr', zip, path.basename(plugin)], { cwd: root, encoding: 'utf8' });
  const row = { id: 'generated-plugin-zip', status: result.error ? 'engine_error' : result.status === 0 && existsSync(zip) ? 'passed' : 'failed', command: 'zip -qr <generated-plugin-zip> block-runner-release-candidate', elapsedMs: 0, detail: result.error?.message ?? (result.status === 0 ? undefined : `exit ${result.status ?? 'unknown'}`), artifacts: retainLogs('generated-plugin-zip', result.stdout ?? '', result.stderr ?? result.error?.message ?? '') };
  rows.push(row); if (row.status !== 'passed') return undefined;
  const retained = path.join(evidenceDirectory, 'artifacts', 'block-runner-release-candidate.zip'); mkdirSync(path.dirname(retained), { recursive: true }); copyFileSync(zip, retained);
  row.artifact = { path: relativeArtifact(retained), sha256: hashFile(retained) };
  return { zip, sha256: row.artifact.sha256, sourceHash: treeHash(plugin) };
}
function activationResult(file) {
  if (!existsSync(file)) throw new Error(`WordPress activation runner did not write ${file}`);
  const result = JSON.parse(readFileSync(file, 'utf8')); const environment = result?.environment;
  if (!result || environment?.wordpress !== '7.1' || !/^sha256:[0-9a-f]{64}$/.test(environment.wordpressHash ?? '') || !/^sha256:[0-9a-f]{64}$/.test(environment.themeHash ?? '') || !/^sha256:[0-9a-f]{64}$/.test(environment.browserHash ?? '') || result.pluginActivated !== true || !Array.isArray(result.registeredBlocks) || !result.registeredBlocks.includes('block-runner/release-candidate') || result.editorBlockVisible !== true || result.logsClean !== true || !Array.isArray(result.logs) || !result.logs.length) {
    throw new Error('WordPress activation result must prove WordPress 7.1, plugin activation, block registration, and clean retained logs');
  }
  return result;
}
function activateGeneratedPluginZip() {
  pluginZip = createGeneratedPluginZip(); if (!pluginZip) return undefined;
  const runner = process.env.BLOCK_RUNNER_WP_ZIP_ACTIVATION_RUNNER;
  if (!runner) return blockedRow('generated-plugin-zip-activation', 'BLOCK_RUNNER_WP_ZIP_ACTIVATION_RUNNER', 'configure the isolated WordPress 7.1 ZIP activation executable');
  const work = mkdtempSync(path.join(tmpdir(), 'block-runner-wp-activation-')); const logs = path.join(work, 'logs'); const resultFile = path.join(work, 'activation-result.json');
  const row = runRow('generated-plugin-zip-activation', runner, ['--plugin-zip', pluginZip.zip, '--result', resultFile, '--log-dir', logs, '--wordpress-version', '7.1', '--expect-block', 'block-runner/release-candidate']);
  if (row.status !== 'passed') return undefined;
  try {
    const result = activationResult(resultFile); const retainedLogs = [];
    for (const relative of result.logs) {
      if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('activation log path must be relative');
      const source = path.resolve(work, relative);
      if (!source.startsWith(`${work}${path.sep}`) || !existsSync(source)) throw new Error(`activation log is missing: ${relative}`);
      const destination = path.join(evidenceDirectory, 'activation-logs', path.basename(source)); mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(source, destination);
      retainedLogs.push({ path: relativeArtifact(destination), sha256: hashFile(destination) });
    }
    if (!retainedLogs.length) throw new Error('activation runner retained no logs');
    row.activation = { pluginZipHash: pluginZip.sha256, logs: retainedLogs, registeredBlock: 'block-runner/release-candidate' };
    return { result, retainedLogs };
  } catch (error) { row.status = 'failed'; row.detail = error instanceof Error ? error.message : String(error); return undefined; }
}

function gitValue(args, fallback) { const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : fallback; }
function authoringProvenance() {
  const directory = path.join(ROOT, 'benchmarks', 'authoring');
  const corpusHash = treeHash(directory, (relative) => relative !== 'hashes.json' && !relative.startsWith('runs/'));
  const fixtureManifestHash = treeHash(directory, (relative) => relative === 'fixtures.json' || relative === 'suite.json' || relative === 'schema.json' || relative.startsWith('fixtures/'));
  const sourceSetHash = treeHash(directory, (relative) => relative.startsWith('sources/'));
  const fixtures = JSON.parse(readFileSync(path.join(directory, 'fixtures.json'), 'utf8')).fixtures;
  const sourceDependencyHash = hash(canonicalJson(fixtures.map((fixture) => ({
    id: fixture.id,
    dependencies: [fixture.source, ...(Array.isArray(fixture.sourceDependencies) ? fixture.sourceDependencies : [])]
      .filter(Boolean)
      .map((dependency) => {
        const relative = typeof dependency.path === 'string' ? dependency.path : '';
        return { path: relative, declaredHash: dependency.sha256, actualHash: hashFile(path.resolve(directory, relative)) };
      }),
  }))));
  const expectedPlanHash = treeHash(directory, (relative) => relative.endsWith('/expected-plan.json'));
  const manifest = JSON.parse(readFileSync(path.join(directory, 'hashes.json'), 'utf8'));
  if (manifest.values?.suiteHash?.value !== corpusHash.replace(/^sha256:/, '')) throw new Error('benchmarks/authoring/hashes.json suiteHash is stale');
  const environment = activation?.result?.environment ?? {};
  return { suiteHash: corpusHash, corpusHash, scorerHash: hash(canonicalJson({ scorer: hashFile(path.join(ROOT, 'scripts', 'authoring', 'score.ts')), runner: hashFile(path.join(ROOT, 'scripts', 'authoring-runner.ts')) })), fixtureManifestHash, sourceSetHash, sourceDependencyHash, expectedPlanHash, promptGuideHash: hash(canonicalJson([hashFile(path.join(directory, 'contract.md')), hashFile(path.join(directory, 'README.md')), treeHash(path.join(directory, 'fixtures'), (relative) => relative.endsWith('/prompt.md'))])), templateHash: hashFile(path.join(directory, 'candidate-contract.json')), dependencyHash: hashFile(path.join(ROOT, 'package-lock.json')), wordpressHash: environment.wordpressHash ?? hash('unverified WordPress 7.1 environment'), themeHash: environment.themeHash ?? hash('unverified theme environment'), browserHash: environment.browserHash ?? hash('unverified browser environment'), generatedSourceHash: pluginZip?.sourceHash ?? hash('no generated plugin ZIP') };
}
function gateFor(...ids) { const row = ids.map((id) => rows.find((item) => item.id === id)).find(Boolean); return { state: row?.status ?? 'blocked', evidence: row?.artifacts?.stdout?.path ?? relativeArtifact(path.join(evidenceDirectory, 'row-results.json')), detail: row?.detail }; }
function buildReceipt() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')); const statuses = rows.map((row) => row.status);
  const status = statuses.includes('engine_error') ? 'engine_error' : statuses.includes('blocked') ? 'blocked' : statuses.includes('failed') ? 'failed' : statuses.length ? 'passed' : 'blocked';
  const retained = rows.flatMap((row) => [row.artifacts?.stdout?.path, row.artifacts?.stderr?.path, row.artifact?.path, ...(row.activation?.logs?.map((log) => log.path) ?? [])].filter(Boolean));
  return {
    schemaVersion: 1, receiptId: `rc.1-${selected}-${startedAt.replace(/[:.]/g, '-')}`, matrixRowId: selected, status, measurementState: 'not_applicable', startedAt, finishedAt: new Date().toISOString(), command: `npm run release:check -- --matrix ${selected}`,
    candidate: { commit: gitValue(['rev-parse', 'HEAD'], '0000000'), packageVersion: pkg.version, worktreeClean: gitValue(['status', '--porcelain'], '') === '' },
    provenance: { ...authoringProvenance(), model: process.env.BLOCK_RUNNER_MODEL ?? 'deterministic release harness', effort: process.env.BLOCK_RUNNER_EFFORT ?? 'not applicable' },
    environment: { os: `${process.platform}-${process.arch}`, node: process.version, npm: spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout?.trim() || 'unavailable', wordpress: '7.1', theme: activation?.result?.environment?.theme ?? 'unverified WordPress fixture theme', browser: activation?.result?.environment?.browser ?? 'unverified browser', driver: activation?.result?.environment?.driver ?? 'unverified fixture driver' },
    timing: { elapsedMs: Math.round(performance.now() - startedMs), method: 'monotonic wall-clock from release-check start through immutable receipt write', timeoutMs: Number(process.env.BLOCK_RUNNER_RELEASE_TIMEOUT_MS ?? 900000) },
    artifacts: { npmTarballHash: packed?.sha256, pluginZipHash: pluginZip?.sha256, stdoutHash: hash(canonicalJson(rows.map((row) => row.artifacts?.stdout?.sha256 ?? ''))), stderrHash: hash(canonicalJson(rows.map((row) => row.artifacts?.stderr?.sha256 ?? ''))), retained: [...new Set(retained.length ? retained : [relativeArtifact(path.join(evidenceDirectory, 'row-results.json'))])] },
    gates: { build: gateFor('candidate-verify'), editor: gateFor('authoring-wordpress-71-proof', 'generated-plugin-zip-activation'), frontend: gateFor('authoring-wordpress-71-proof'), pattern: gateFor('authoring-wordpress-71-proof'), fidelity: gateFor('authoring-wordpress-71-proof'), accessibility: gateFor('authoring-wordpress-71-proof') },
    measurement: { suiteSize: 13, workload: '0.9 release candidate matrix', invalidCount: statuses.filter((value) => value === 'blocked' || value === 'engine_error').length, warnings: [] },
  };
}
function validateReleaseReceipt(receipt) {
  const failures = []; const required = ['schemaVersion', 'receiptId', 'matrixRowId', 'status', 'measurementState', 'startedAt', 'finishedAt', 'command', 'candidate', 'provenance', 'environment', 'timing', 'artifacts', 'gates'];
  for (const key of required) if (!(key in receipt)) failures.push(`missing ${key}`);
  for (const key of Object.keys(receipt)) if (!new Set([...required, 'supersedes', 'measurement']).has(key)) failures.push(`unsupported top-level field ${key}`);
  if (receipt.schemaVersion !== 1 || !['passed', 'failed', 'unsupported', 'blocked', 'engine_error'].includes(receipt.status) || !['scored', 'unsupported', 'blocked', 'engine_error', 'not_applicable'].includes(receipt.measurementState)) failures.push('invalid receipt status fields');
  if (!/^0\.9\.0(?:[-+][0-9A-Za-z.-]+)?$/.test(receipt.candidate?.packageVersion ?? '') || !/^[0-9a-f]{7,64}$/.test(receipt.candidate?.commit ?? '') || typeof receipt.candidate?.worktreeClean !== 'boolean') failures.push('invalid candidate identity');
  for (const key of ['suiteHash', 'corpusHash', 'scorerHash', 'fixtureManifestHash', 'sourceSetHash', 'sourceDependencyHash', 'expectedPlanHash', 'promptGuideHash', 'templateHash', 'dependencyHash', 'wordpressHash', 'themeHash', 'browserHash', 'generatedSourceHash']) if (!/^sha256:[0-9a-f]{64}$/.test(receipt.provenance?.[key] ?? '')) failures.push(`invalid provenance ${key}`);
  if (receipt.environment?.wordpress !== '7.1') failures.push('receipt environment must target WordPress 7.1');
  for (const key of ['os', 'node', 'npm', 'theme', 'browser', 'driver']) if (typeof receipt.environment?.[key] !== 'string' || !receipt.environment[key]) failures.push(`missing environment ${key}`);
  if (!Number.isInteger(receipt.timing?.elapsedMs) || receipt.timing.elapsedMs < 0 || !Number.isInteger(receipt.timing?.timeoutMs) || receipt.timing.timeoutMs < 1) failures.push('invalid timing');
  for (const key of ['stdoutHash', 'stderrHash']) if (!/^sha256:[0-9a-f]{64}$/.test(receipt.artifacts?.[key] ?? '')) failures.push(`invalid artifacts ${key}`);
  if (!Array.isArray(receipt.artifacts?.retained) || !receipt.artifacts.retained.length) failures.push('missing retained artifacts');
  for (const key of ['build', 'editor', 'frontend', 'pattern', 'fidelity', 'accessibility']) { const gate = receipt.gates?.[key]; if (!gate || !['passed', 'failed', 'unsupported', 'blocked', 'engine_error'].includes(gate.state) || typeof gate.evidence !== 'string' || !gate.evidence) failures.push(`invalid gate ${key}`); }
  return failures;
}
