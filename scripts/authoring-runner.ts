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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  AUTHORING_DIMENSIONS,
  authoringHashes,
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

const TIMING_METHOD = 'monotonic-wall-clock-source-materialization-through-receipt-write';

function valueFor(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function sha256File(file: string): string {
  return hashFile(file);
}

function write(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
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

function materializeCandidate(fixture: AuthoringFixture, suiteDirectory: string, candidateDirectory: string, receiptDirectory: string): ReceiptArtifact {
  mkdirSync(candidateDirectory, { recursive: true });
  const source = fixture.source?.path ? path.join(suiteDirectory, fixture.source.path) : undefined;
  const plan = fixture.plan ? path.join(suiteDirectory, fixture.plan) : undefined;
  if (!source || !existsSync(source) || !plan || !existsSync(plan)) throw new Error(`${fixture.id} has missing source or expected plan`);

  const blockName = `block-runner/${fixture.id}`;
  write(
    path.join(candidateDirectory, 'block.json'),
    `${JSON.stringify({
      $schema: 'https://schemas.wp.org/trunk/block.json',
      apiVersion: 3,
      name: blockName,
      title: `Authoring fixture ${fixture.id}`,
      category: 'widgets',
      editorScript: 'file:./build/index.js',
      style: 'file:./build/style-index.css',
      attributes: {},
    }, null, 2)}\n`,
  );
  write(
    path.join(candidateDirectory, 'block-runner-authoring.php'),
    `<?php\n/** Plugin Name: Block Runner authoring fixture ${fixture.id} */\nadd_action( 'init', static function () { register_block_type( __DIR__ ); } );\n`,
  );
  write(
    path.join(candidateDirectory, 'src', 'edit.tsx'),
    `export default function Edit() { return <p>${fixture.id} editor fixture</p>; }\n`,
  );
  write(
    path.join(candidateDirectory, 'src', 'save.tsx'),
    `export default function save() { return <p>${fixture.id} saved fixture</p>; }\n`,
  );
  write(path.join(candidateDirectory, 'src', 'style-ledger.json'), `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`);
  copyFileSync(plan, path.join(candidateDirectory, 'authoring-plan.json'));
  copyFileSync(source, path.join(candidateDirectory, 'source', path.basename(source)));
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
  copyFileSync(sourceManifest, retained);
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
  return result as WorkerResult;
}

function copyWorkerArtifacts(
  worker: WorkerResult,
  candidateDirectory: string,
  receiptDirectory: string,
  fixture: AuthoringFixture,
): Record<string, ReceiptArtifact> {
  const copied: Record<string, ReceiptArtifact> = {};
  for (const [name, candidate] of Object.entries(worker.artifacts ?? {})) {
    if (!candidate || typeof candidate.path !== 'string' || path.isAbsolute(candidate.path)) {
      throw new Error(`authoring worker artifact ${name} must use a candidate-relative path`);
    }
    const source = path.resolve(candidateDirectory, candidate.path);
    if (!source.startsWith(`${path.resolve(candidateDirectory)}${path.sep}`) || !existsSync(source)) {
      throw new Error(`authoring worker artifact ${name} is missing: ${candidate.path}`);
    }
    const destination = path.join(receiptDirectory, 'artifacts', fixture.id, `${name}-${path.basename(source)}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
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
  generatedSourceManifest: ReceiptArtifact,
  workerArtifacts: Record<string, ReceiptArtifact>,
  standardArtifacts: Record<string, ReceiptArtifact>,
  hashes: ReturnType<typeof authoringHashes>,
): AuthoringReceipt {
  const artifacts = { generatedSourceManifest, ...standardArtifacts, ...workerArtifacts };
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
  const rawEnvironment = worker.environment ?? {};
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
      sourceHash: fixture.source?.sha256 ? `sha256:${fixture.source.sha256.replace(/^sha256:/, '')}` : sha256('missing source identity'),
      generatedSourceHash: generatedSourceManifest.sha256,
      model: process.env.BLOCK_RUNNER_MODEL ?? 'external-authoring-worker',
      effort: process.env.BLOCK_RUNNER_EFFORT ?? 'external-fixture-run',
    },
    environment: {
      wordpress: rawEnvironment.wordpress ?? '7.1',
      theme: rawEnvironment.theme ?? 'twentytwentyfive fixtures/theme.json',
      browser: rawEnvironment.browser ?? 'chromium 1440x1024',
      driver: rawEnvironment.driver ?? 'authoring fixture worker',
    },
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

function blockedReceipt(
  fixture: AuthoringFixture,
  receiptDirectory: string,
  startedAt: string,
  startedMs: number,
  generatedSourceManifest: ReceiptArtifact,
  hashes: ReturnType<typeof authoringHashes>,
  message: string,
): AuthoringReceipt {
  const statusFile = path.join(receiptDirectory, 'artifacts', fixture.id, 'runner-status.txt');
  write(statusFile, `${message}\n`);
  const status = artifact(statusFile, receiptDirectory);
  return receiptFromWorker(
    fixture,
    { status: 'blocked', checks: {}, artifacts: {}, environment: {} },
    receiptDirectory,
    startedAt,
    startedMs,
    generatedSourceManifest,
    {},
    { runnerStatus: status },
    hashes,
  );
}

function executeFixture(
  fixture: AuthoringFixture,
  suiteDirectory: string,
  runDirectory: string,
  runner: string | undefined,
  hashes: ReturnType<typeof authoringHashes>,
): AuthoringReceipt {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const candidateDirectory = path.join(runDirectory, 'candidates', fixture.id);
  const receiptDirectory = path.join(runDirectory, 'receipts');
  const generatedSourceManifest = materializeCandidate(fixture, suiteDirectory, candidateDirectory, receiptDirectory);
  if (!runner) {
    return blockedReceipt(
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
  const processResult = spawnSync(runner, [
    '--fixture-id', fixture.id,
    '--candidate-dir', candidateDirectory,
    '--result', resultFile,
    '--wordpress-version', '7.1',
    '--theme-config', path.join(suiteDirectory, 'fixtures', 'theme.json'),
    '--browser', 'chromium',
    '--viewport', '1440x1024',
    '--source', path.join(suiteDirectory, fixture.source?.path ?? ''),
    '--expected-plan', path.join(suiteDirectory, fixture.plan ?? ''),
  ], { cwd: candidateDirectory, encoding: 'utf8', env: process.env });
  const stdoutFile = path.join(receiptDirectory, 'artifacts', fixture.id, 'worker.stdout.log');
  const stderrFile = path.join(receiptDirectory, 'artifacts', fixture.id, 'worker.stderr.log');
  write(stdoutFile, processResult.stdout ?? '');
  write(stderrFile, processResult.stderr ?? processResult.error?.message ?? '');
  const standardArtifacts = { workerStdout: artifact(stdoutFile, receiptDirectory), workerStderr: artifact(stderrFile, receiptDirectory) };
  if (processResult.error || processResult.status !== 0) {
    return blockedReceipt(
      fixture,
      receiptDirectory,
      startedAt,
      startedMs,
      generatedSourceManifest,
      hashes,
      `authoring worker failed: ${processResult.error?.message ?? `exit ${processResult.status ?? 'unknown'}`}`,
    );
  }
  try {
    const worker = loadWorkerResult(resultFile);
    const copied = copyWorkerArtifacts(worker, candidateDirectory, receiptDirectory, fixture);
    return receiptFromWorker(fixture, worker, receiptDirectory, startedAt, startedMs, generatedSourceManifest, copied, standardArtifacts, hashes);
  } catch (error) {
    return blockedReceipt(
      fixture,
      receiptDirectory,
      startedAt,
      startedMs,
      generatedSourceManifest,
      hashes,
      `authoring worker result was unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main(): void {
  const suiteDirectory = path.resolve(valueFor('--suite') ?? 'benchmarks/authoring');
  const suppliedRunDirectory = valueFor('--run-root');
  const runDirectory = suppliedRunDirectory
    ? path.resolve(suppliedRunDirectory)
    : path.join(tmpdir(), `block-runner-authoring-${Date.now()}-${process.pid}`);
  if (existsSync(runDirectory)) throw new Error(`refusing to overwrite authoring run directory: ${runDirectory}`);
  mkdirSync(runDirectory, { recursive: true });
  const runner = valueFor('--runner') ?? process.env.BLOCK_RUNNER_AUTHORING_RUNNER;
  const suite = loadAuthoringSuite(suiteDirectory);
  const hashes = authoringHashes(suite);
  const receipts = suite.fixtures.map((fixture) => executeFixture(fixture, suiteDirectory, runDirectory, runner, hashes));
  for (const receipt of receipts) {
    const file = path.join(runDirectory, 'receipts', `${receipt.fixtureId}.json`);
    if (existsSync(file)) throw new Error(`refusing to overwrite fixture receipt: ${file}`);
    write(file, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  const scores = suite.fixtures.map((fixture) => {
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
    hashes,
    scores,
    summary: summarizeAuthoringScores(scores),
    metadata: {
      workload: '0.9 release fixture set',
      model: process.env.BLOCK_RUNNER_MODEL ?? 'external-authoring-worker',
      effort: process.env.BLOCK_RUNNER_EFFORT ?? 'external-fixture-run',
      timingMethod: TIMING_METHOD,
      startedAt: new Date().toISOString(),
      runDirectory,
    },
  };
  write(path.join(runDirectory, 'authoring-run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.log(JSON.stringify(run, null, 2));
  if (!run.summary.contractPass) process.exitCode = 1;
}

main();
