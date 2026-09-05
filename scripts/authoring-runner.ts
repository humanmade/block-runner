/**
 * Execute the registered-block authoring corpus in a fresh candidate workspace.
 *
 * WordPress/browser automation lives in an isolated fixture image, so this
 * runner invokes a configured executable once per fixture.  It never imports a
 * receipt from a previous run: it materializes the candidate, supplies the
 * exact WordPress 7.1/editor/front-end/pattern/fidelity/a11y contract, and only
 * accepts the worker result after copying and hashing its evidence.
 */
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { AuthoringGenerationError, compileRegisteredBlock } from '../src/authoring/generate.js';
import { validateAuthoringPlan } from '../src/authoring/schema.js';
import {
  AUTHORING_DIMENSIONS,
  AUTHORING_RUNTIME_ARTIFACTS,
  authoringHashes,
  fixtureContractFailures,
  hashFile,
  loadAuthoringSuite,
  scoreAuthoringFixture,
  sha256,
  summarizeAuthoringScores,
  validateAuthoringReceipt,
  type AuthoringFixture,
  type AuthoringReceipt,
  type ReceiptArtifact,
} from './authoring/score.js';

const TIMING_METHOD = 'monotonic-wall-clock-source-materialization-through-evidence-finalization';

function valueFor(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

function sha256File(file: string): string {
  return hashFile(file);
}

function write(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, { encoding: 'utf8', flag: 'wx' });
}

function filesBelow(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

function artifact(file: string, receiptDirectory: string): ReceiptArtifact {
  return { path: path.relative(receiptDirectory, file).split(path.sep).join('/'), sha256: sha256File(file) };
}

function suiteFile(
  suiteDirectory: string,
  relative: string,
  declaredHash: unknown,
): { source: string; relative: string; bytes: Buffer } {
  const source = path.resolve(suiteDirectory, relative);
  const suiteRoot = realpathSync(suiteDirectory);
  if (!existsSync(source) || !lstatSync(source).isFile()
    || !realpathSync(source).startsWith(`${suiteRoot}${path.sep}`)) {
    throw new Error(`source input must be a regular file inside the suite: ${relative}`);
  }
  const bytes = readFileSync(source);
  if (typeof declaredHash === 'string' && sha256(bytes) !== `sha256:${declaredHash.replace(/^sha256:/, '')}`) {
    throw new Error(`source input bytes do not match the declared hash: ${relative}`);
  }
  return { source, relative: path.relative(suiteDirectory, source).split(path.sep).join('/'), bytes };
}

function candidateSourcePath(candidateDirectory: string, relative: string): string {
  return path.join(candidateDirectory, 'source', relative);
}

export function materializeCandidate(fixture: AuthoringFixture, suiteDirectory: string, candidateDirectory: string, receiptDirectory: string, candidatePlan: string, planSnapshot?: Buffer): ReceiptArtifact {
  if (!/^[a-z0-9-]+$/.test(fixture.id)) throw new Error('unsafe fixture id');
  if (!fixture.source?.path || !existsSync(candidatePlan)) throw new Error(`${fixture.id} has missing source or candidate plan`);
  const sourceInput = suiteFile(suiteDirectory, fixture.source.path, fixture.source.sha256);
  const dependencyInputs = (Array.isArray(fixture.sourceDependencies) ? fixture.sourceDependencies : []).map((dependency, index) => {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)
      || typeof (dependency as { path?: unknown }).path !== 'string') {
      throw new Error(`invalid source dependency declaration for ${fixture.id} at index ${index}`);
    }
    const value = dependency as { path: string; sha256?: unknown };
    return suiteFile(suiteDirectory, value.path, value.sha256);
  });
  // Expected plans are scoring contracts, not model output and not source code.
  // Only a supplied canonical candidate may enter the production compiler.
  const candidateBytes = planSnapshot ?? readFileSync(candidatePlan);
  const plan = validateAuthoringPlan(candidateBytes.toString('utf8'));
  const compiled = compileRegisteredBlock(plan);
  if (existsSync(candidateDirectory)) throw new Error(`refusing to overwrite candidate: ${candidateDirectory}`);
  mkdirSync(candidateDirectory, { recursive: true });
  for (const file of [...compiled.files, ...compiled.assets]) {
    const destination = path.join(candidateDirectory, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.content, { flag: 'wx' });
  }
  // These are the confirmed style decisions, not a per-source-declaration coverage ledger.
  // The worker must provide the latter before claiming the style dimension was measured.
  write(path.join(candidateDirectory, 'style-decisions.json'), `${JSON.stringify(plan.styles, null, 2)}\n`);
  write(path.join(candidateDirectory, 'compiler-manifest.json'), `${JSON.stringify(compiled.manifest, null, 2)}\n`);
  writeFileSync(path.join(candidateDirectory, 'authoring-plan.json'), candidateBytes, { flag: 'wx' });
  for (const input of [sourceInput, ...dependencyInputs]) {
    const destination = candidateSourcePath(candidateDirectory, input.relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, input.bytes, { flag: 'wx' });
  }
  const sourceManifest = path.join(candidateDirectory, 'generated-source-manifest.json');
  write(
    sourceManifest,
    `${JSON.stringify(
      filesBelow(candidateDirectory)
        .filter((file) => file !== sourceManifest)
        .map((file) => ({ path: path.relative(candidateDirectory, file).split(path.sep).join('/'), sha256: sha256File(file) })),
      null,
      2,
    )}\n`,
  );
  const retained = path.join(receiptDirectory, 'artifacts', fixture.id, 'generated-source-manifest.json');
  mkdirSync(path.dirname(retained), { recursive: true });
  copyFileSync(sourceManifest, retained, constants.COPYFILE_EXCL);
  return artifact(retained, receiptDirectory);
}

interface WorkerArtifact {
  path?: unknown;
}

interface WorkerResult {
  status?: unknown;
  checks?: Record<string, { pass?: unknown; detail?: unknown; evidence?: unknown }>;
  artifacts?: Record<string, WorkerArtifact>;
  failClosed?: { warningCode?: unknown; noInteractiveRuntime?: unknown; evidence?: unknown };
  environment?: Record<string, unknown>;
}

function loadWorkerResult(file: string): WorkerResult {
  if (!existsSync(file)) throw new Error(`authoring worker did not write result: ${file}`);
  const result = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('authoring worker result must be a JSON object');
  const candidate = result as WorkerResult;
  if (!['scored', 'unsupported', 'blocked', 'engine_error'].includes(candidate.status as string)) {
    throw new Error('authoring worker result status must be scored, unsupported, blocked, or engine_error');
  }
  if (candidate.checks !== undefined && (!candidate.checks || typeof candidate.checks !== 'object' || Array.isArray(candidate.checks))) {
    throw new Error('authoring worker checks must be a JSON object');
  }
  if (candidate.artifacts !== undefined && (!candidate.artifacts || typeof candidate.artifacts !== 'object' || Array.isArray(candidate.artifacts))) {
    throw new Error('authoring worker artifacts must be a JSON object');
  }
  if (candidate.failClosed !== undefined && (!candidate.failClosed || typeof candidate.failClosed !== 'object' || Array.isArray(candidate.failClosed))) {
    throw new Error('authoring worker failClosed must be a JSON object');
  }
  return candidate;
}

function copyWorkerArtifacts(
  worker: WorkerResult,
  candidateDirectory: string,
  receiptDirectory: string,
  fixture: AuthoringFixture,
): Record<string, ReceiptArtifact> {
  const copied: Record<string, ReceiptArtifact> = {};
  for (const [name, candidate] of Object.entries(worker.artifacts ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) throw new Error('worker artifact name must be a simple identifier');
    if (['generatedSourceManifest', 'workerStdout', 'workerStderr', 'runnerStatus', 'compilerRefusal', 'candidateInput'].includes(name)) {
      throw new Error(`worker artifact cannot replace runner-owned evidence: ${name}`);
    }
    if (!candidate || typeof candidate.path !== 'string' || path.isAbsolute(candidate.path)) {
      throw new Error(`authoring worker artifact ${name} must use a candidate-relative path`);
    }
    const source = path.resolve(candidateDirectory, candidate.path);
    if (!source.startsWith(`${path.resolve(candidateDirectory)}${path.sep}`) || !existsSync(source)) {
      throw new Error(`authoring worker artifact ${name} is missing: ${candidate.path}`);
    }
    if (!lstatSync(source).isFile() || !realpathSync(source).startsWith(`${realpathSync(candidateDirectory)}${path.sep}`)) {
      throw new Error(`authoring worker artifact ${name} must be a regular file inside the candidate directory`);
    }
    const destination = path.join(receiptDirectory, 'artifacts', fixture.id, `${name}-${path.basename(source)}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    copied[name] = artifact(destination, receiptDirectory);
  }
  return copied;
}

function evidence(value: unknown, copied: Record<string, ReceiptArtifact>): ReceiptArtifact[] {
  const values = Array.isArray(value) ? value : [value];
  const resolved: ReceiptArtifact[] = [];
  for (const item of values) {
    if (typeof item === 'string' && copied[item]) resolved.push(copied[item]);
    else if (item && typeof item === 'object' && typeof (item as { artifact?: unknown }).artifact === 'string') {
      const named = copied[(item as { artifact: string }).artifact];
      if (named) resolved.push(named);
    }
  }
  return resolved;
}

function receiptFromWorker(
  fixture: AuthoringFixture,
  worker: WorkerResult,
  receiptDirectory: string,
  startedAt: string,
  startedMs: number,
  generatedSourceManifest: ReceiptArtifact | null,
  workerArtifacts: Record<string, ReceiptArtifact>,
  standardArtifacts: Record<string, ReceiptArtifact>,
  hashes: ReturnType<typeof authoringHashes>,
): AuthoringReceipt {
  const artifacts: Record<string, ReceiptArtifact> = {
    ...standardArtifacts,
    ...workerArtifacts,
    ...(generatedSourceManifest ? { generatedSourceManifest } : {}),
  };
  const checks = Object.fromEntries(
    Object.entries(worker.checks ?? {}).map(([name, value]) => [
      name,
      {
        pass: value?.pass,
        detail: typeof value?.detail === 'string' ? value.detail : undefined,
        evidence: evidence(value?.evidence, artifacts),
      },
    ]),
  );
  const observed = (name: string): Record<string, unknown> | null => {
    const reference = artifacts[name];
    if (!reference) return null;
    try {
      const value = JSON.parse(readFileSync(path.resolve(receiptDirectory, reference.path), 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  };
  const environment = {
    wordpress: observed('wordpressInventory'),
    theme: observed('themeInventory'),
    browser: observed('browserInventory'),
  };
  return {
    schemaVersion: 1,
    fixtureId: fixture.id,
    status: worker.status as AuthoringReceipt['status'],
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedMs),
    timingMethod: TIMING_METHOD,
    provenance: {
      ...hashes,
      sourceHash: fixture.source?.sha256 ? `sha256:${fixture.source.sha256.replace(/^sha256:/, '')}` : null,
      generatedSourceHash: generatedSourceManifest?.sha256 ?? null,
      ...Object.fromEntries(Object.entries(AUTHORING_RUNTIME_ARTIFACTS)
        .map(([key, name]) => [key, artifacts[name]?.sha256 ?? null])),
      // This runner executes a saved candidate and a runtime worker; it never invokes a model.
      // Keep that fact visible even when a shell happens to contain model-related environment
      // variables from a separate benchmark process.
      model: 'not-run (saved canonical plan)',
      effort: 'none',
    },
    environment,
    checks,
    artifacts,
    failClosed: worker.failClosed
      ? {
          warningCode: worker.failClosed.warningCode as string | undefined,
          noInteractiveRuntime: worker.failClosed.noInteractiveRuntime as boolean | undefined,
          evidence: evidence(worker.failClosed.evidence, artifacts),
        }
      : undefined,
  };
}

function unsuccessfulReceipt(
  fixture: AuthoringFixture,
  receiptDirectory: string,
  startedAt: string,
  startedMs: number,
  generatedSourceManifest: ReceiptArtifact | null,
  hashes: ReturnType<typeof authoringHashes>,
  message: string,
  outcome: 'blocked' | 'engine_error' = 'blocked',
  retainedArtifacts: Record<string, ReceiptArtifact> = {},
): AuthoringReceipt {
  const statusFile = path.join(receiptDirectory, 'artifacts', fixture.id, 'runner-status.txt');
  write(statusFile, `${message}\n`);
  const status = artifact(statusFile, receiptDirectory);
  const receipt = receiptFromWorker(
    fixture,
    { status: outcome, checks: {}, artifacts: {}, environment: {} },
    receiptDirectory,
    startedAt,
    startedMs,
    generatedSourceManifest,
    {},
    { ...retainedArtifacts, runnerStatus: status },
    hashes,
  );
  if (outcome === 'engine_error') receipt.error = { kind: 'engine', message };
  return receipt;
}

export function executeFixture(
  fixture: AuthoringFixture,
  suiteDirectory: string,
  runDirectory: string,
  runner: string | undefined,
  hashes: ReturnType<typeof authoringHashes>,
  plansDirectory: string | undefined,
  workerTimeoutMs = 480_000,
): AuthoringReceipt {
  if (!/^[a-z0-9-]+$/.test(fixture.id)) throw new Error('unsafe fixture id');
  if (!Number.isSafeInteger(workerTimeoutMs) || workerTimeoutMs < 1) throw new Error('worker timeout must be a positive integer');
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const candidateDirectory = path.join(runDirectory, 'candidates', fixture.id);
  const receiptDirectory = path.join(runDirectory, 'receipts');
  if (!plansDirectory) {
    return unsuccessfulReceipt(
      fixture,
      receiptDirectory,
      startedAt,
      startedMs,
      null,
      hashes,
      'saved canonical candidate plans were not supplied; provide --plans <directory> before running authoring proof',
      'blocked',
    );
  }
  const candidatePlan = path.join(plansDirectory, `${fixture.id}.json`);
  let planSnapshot: Buffer | undefined;
  let generatedSourceManifest: ReceiptArtifact;
  try {
    planSnapshot = readFileSync(candidatePlan);
    generatedSourceManifest = materializeCandidate(fixture, suiteDirectory, candidateDirectory, receiptDirectory, candidatePlan, planSnapshot);
  } catch (error) {
    if (isMissingFileError(error)) {
      return unsuccessfulReceipt(
        fixture,
        receiptDirectory,
        startedAt,
        startedMs,
        null,
        hashes,
        `saved canonical candidate plan is missing: ${path.relative(plansDirectory, candidatePlan)}`,
        'blocked',
      );
    }
    const message = `candidate compilation failed: ${error instanceof Error ? error.message : String(error)}`;
    const failureArtifact = path.join(receiptDirectory, 'artifacts', fixture.id, 'compilation-failure.json');
    // Only this compiler diagnostic proves a deliberate static-contract refusal. A malformed
    // plan, a missing asset, or an I/O failure is not an expected-negative success.
    const unsupported = error instanceof AuthoringGenerationError && error.reason.startsWith('unsupported-executable-behaviour:');
    write(failureArtifact, `${JSON.stringify({ materializationCompleted: false, error: message,
      ...(unsupported ? { warningCode: 'BR_UNSUPPORTED_INTERACTION', noInteractiveRuntime: true } : {}),
    }, null, 2)}\n`);
    const inputs: Record<string, ReceiptArtifact> = {};
    if (planSnapshot) {
      const retained = path.join(path.dirname(failureArtifact), 'candidate-input.json');
      writeFileSync(retained, planSnapshot, { flag: 'wx' });
      inputs.candidateInput = artifact(retained, receiptDirectory);
    }
    if (unsupported) {
      const reference = artifact(failureArtifact, receiptDirectory);
      return receiptFromWorker(fixture, {
        status: 'unsupported',
        checks: { warnings: { pass: true, detail: message, evidence: 'compilerRefusal' } },
        failClosed: { warningCode: 'BR_UNSUPPORTED_INTERACTION', noInteractiveRuntime: true, evidence: 'compilerRefusal' },
      }, receiptDirectory, startedAt, startedMs, null, {}, { ...inputs, compilerRefusal: reference }, hashes);
    }
    return unsuccessfulReceipt(fixture, receiptDirectory, startedAt, startedMs, null, hashes, message, 'engine_error', {
      ...inputs,
      compilerFailure: artifact(failureArtifact, receiptDirectory),
    });
  }
  if (!runner) {
    return unsuccessfulReceipt(
      fixture,
      receiptDirectory,
      startedAt,
      startedMs,
      generatedSourceManifest,
      hashes,
      'BLOCK_RUNNER_AUTHORING_RUNNER is required to execute WordPress 7.1/editor/front-end/pattern/fidelity/accessibility gates',
    );
  }

  const resultFile = path.join(candidateDirectory, 'worker-result.json');
  const candidateRoot = realpathSync(candidateDirectory);
  const sourcePath = fixture.source?.path
    ? candidateSourcePath(candidateDirectory, path.relative(suiteDirectory, path.resolve(suiteDirectory, fixture.source.path)).split(path.sep).join('/'))
    : undefined;
  const sourceDependencies = (Array.isArray(fixture.sourceDependencies) ? fixture.sourceDependencies : [])
    .filter((dependency): dependency is { path: string } => Boolean(dependency && typeof dependency === 'object'
      && !Array.isArray(dependency) && typeof (dependency as { path?: unknown }).path === 'string'))
    .map((dependency) => candidateSourcePath(candidateDirectory, path.relative(suiteDirectory, path.resolve(suiteDirectory, dependency.path)).split(path.sep).join('/')));
  // Keep the exact pre-worker source contract in memory. The worker cannot bless a modified
  // implementation by replacing its on-disk manifest after the build.
  const candidateFiles = JSON.parse(readFileSync(path.join(receiptDirectory, generatedSourceManifest.path), 'utf8')) as Array<{ path: string; sha256: string }>;
  const workerArgs = [
    '--fixture-id', fixture.id,
    '--candidate-dir', candidateDirectory,
    '--result', resultFile,
    '--wordpress-version', '7.1',
    '--theme-config', path.join(suiteDirectory, 'fixtures', 'theme.json'),
    '--browser', 'chromium',
    '--viewport', '1440x1024',
    ...(sourcePath ? ['--source', sourcePath] : []),
    ...sourceDependencies.flatMap((dependency) => ['--source-dependency', dependency]),
    '--candidate-plan', path.join(candidateDirectory, 'authoring-plan.json'),
    '--expected-plan', path.join(suiteDirectory, fixture.plan ?? ''),
  ];
  const processResult = spawnSync(runner, workerArgs, { cwd: candidateDirectory, encoding: 'utf8', env: process.env, timeout: workerTimeoutMs, maxBuffer: 10 * 1024 * 1024 });
  const stdoutFile = path.join(receiptDirectory, 'artifacts', fixture.id, 'worker.stdout.log');
  const stderrFile = path.join(receiptDirectory, 'artifacts', fixture.id, 'worker.stderr.log');
  write(stdoutFile, processResult.stdout ?? '');
  write(stderrFile, processResult.stderr ?? processResult.error?.message ?? '');
  const standardArtifacts = { workerStdout: artifact(stdoutFile, receiptDirectory), workerStderr: artifact(stderrFile, receiptDirectory) };
  if (processResult.error || processResult.status !== 0) {
    return unsuccessfulReceipt(
      fixture,
      receiptDirectory,
      startedAt,
      startedMs,
      generatedSourceManifest,
      hashes,
      `authoring worker failed: ${processResult.error?.message ?? `exit ${processResult.status ?? 'unknown'}`}`,
      'engine_error',
      standardArtifacts,
    );
  }
  try {
    for (const file of candidateFiles) {
      const target = path.join(candidateDirectory, file.path);
      if (!existsSync(target) || !lstatSync(target).isFile()
        || !realpathSync(target).startsWith(`${candidateRoot}${path.sep}`) || hashFile(target) !== file.sha256) {
        throw new Error(`worker changed generated candidate source: ${file.path}`);
      }
    }
    const worker = loadWorkerResult(resultFile);
    if (worker.status === 'scored') {
      const failures = fixtureContractFailures({ ...fixture, candidate: { ...fixture.candidate, artifactRoot: candidateDirectory } }, suiteDirectory);
      if (failures.length) throw new Error(`scored worker omitted its candidate contract: ${failures.join('; ')}`);
    }
    const copied = copyWorkerArtifacts(worker, candidateDirectory, receiptDirectory, fixture);
    return receiptFromWorker(fixture, worker, receiptDirectory, startedAt, startedMs, generatedSourceManifest, copied, standardArtifacts, hashes);
  } catch (error) {
    return unsuccessfulReceipt(
      fixture,
      receiptDirectory,
      startedAt,
      startedMs,
      generatedSourceManifest,
      hashes,
      `authoring worker result was unusable: ${error instanceof Error ? error.message : String(error)}`,
      'engine_error',
      standardArtifacts,
    );
  }
}

function main(): void {
  const suiteDirectory = path.resolve(valueFor('--suite') ?? 'benchmarks/authoring');
  const suppliedPlans = valueFor('--plans');
  const plansDirectory = suppliedPlans ? path.resolve(suppliedPlans) : undefined;
  if (plansDirectory && (!existsSync(plansDirectory) || !lstatSync(plansDirectory).isDirectory())) {
    throw new Error(`candidate plan directory must be an existing directory: ${plansDirectory}`);
  }
  const selectedFixture = valueFor('--fixture');
  const suppliedRunDirectory = valueFor('--run-root');
  const runDirectory = suppliedRunDirectory
    ? path.resolve(suppliedRunDirectory)
    : path.join(tmpdir(), `block-runner-authoring-${Date.now()}-${process.pid}`);
  if (existsSync(runDirectory)) throw new Error(`refusing to overwrite authoring run directory: ${runDirectory}`);
  const runner = valueFor('--runner') ?? process.env.BLOCK_RUNNER_AUTHORING_RUNNER;
  const suite = loadAuthoringSuite(suiteDirectory);
  const fixtures = selectedFixture
    ? suite.fixtures.filter((fixture) => fixture.id === selectedFixture)
    : suite.fixtures;
  if (selectedFixture && fixtures.length !== 1) throw new Error(`unknown authoring fixture: ${selectedFixture}`);
  const hashes = authoringHashes(suite);
  mkdirSync(path.dirname(runDirectory), { recursive: true });
  mkdirSync(runDirectory);
  const receipts: AuthoringReceipt[] = [];
  for (const fixture of fixtures) {
    const receipt = executeFixture(fixture, suiteDirectory, runDirectory, runner, hashes, plansDirectory);
    const file = path.join(runDirectory, 'receipts', `${receipt.fixtureId}.json`);
    if (existsSync(file)) throw new Error(`refusing to overwrite fixture receipt: ${file}`);
    write(file, `${JSON.stringify(receipt, null, 2)}\n`);
    receipts.push(receipt);
  }
  const scores = fixtures.map((fixture) => {
    const receipt = receipts.find((item) => item.fixtureId === fixture.id)!;
    const failures = validateAuthoringReceipt(fixture, receipt, suiteDirectory, path.join(runDirectory, 'receipts'));
    return scoreAuthoringFixture(
      fixture,
      failures.length
        ? { status: 'engine_error', error: { kind: 'engine', message: `generated receipt failed schema/evidence validation: ${failures.join('; ')}` } }
        : receipt,
    );
  });
  const run = {
    contract: 'block-runner.authoring-benchmark/v0.9',
    hashScope: 'suite-requirements; observed runtime hashes are recorded per fixture',
    hashes,
    scores,
    summary: summarizeAuthoringScores(scores),
    metadata: {
      workload: selectedFixture ? `0.9 authoring fixture: ${selectedFixture}` : '0.9 release fixture set',
      model: 'not-run (saved canonical plan)',
      effort: 'none',
      candidateOrigin: 'saved-canonical-plan',
      ...(selectedFixture ? { fixture: selectedFixture } : {}),
      timingMethod: TIMING_METHOD,
      startedAt: new Date().toISOString(),
      runDirectory,
    },
  };
  write(path.join(runDirectory, 'authoring-run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.log(JSON.stringify(run, null, 2));
  if (!run.summary.contractPass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
