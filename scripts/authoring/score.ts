/**
 * Registered-block authoring benchmark contract.
 *
 * This suite intentionally does not share a score with `scripts/tuner/score.ts`.
 * That scorer measures HTML-to-page-block conversion; this one measures the work
 * required to author, package, activate, and use a registered block.  A result is
 * therefore a vector of independently inspectable dimensions, never a proxy for
 * page-content quality.
 *
 * Fixtures are specifications, not evidence.  Each fixture points at a receipt
 * written by an execution (normally below an ignored `runs/` directory).  A
 * missing receipt is `blocked`, rather than an invented green result.  Receipts
 * produced by a model or tool failure are `engine_error`, an invalid measurement
 * that is excluded from all product reporting rather than scored as zero.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The independently scored product qualities. Their order is stable for exports. */
export const AUTHORING_DIMENSIONS = [
  'plan',
  'source',
  'native',
  'style',
  'warnings',
  'build',
  'editor',
  'frontend',
  'pattern',
  'fidelity',
  'accessibility',
] as const;

export type AuthoringDimension = (typeof AUTHORING_DIMENSIONS)[number];
export type AuthoringStatus = 'unsupported' | 'blocked' | 'engine_error' | 'scored';
export type ExpectedStatus = Exclude<AuthoringStatus, 'engine_error'>;

export const AUTHORING_BENCHMARK_CONTRACT = 'block-runner.authoring-benchmark/v0.9';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUITE_DIRECTORIES = new WeakMap<AuthoringSuite, string>();
const DIMENSION_ALIASES: Record<string, AuthoringDimension> = {
  plan: 'plan',
  source: 'source',
  native: 'native',
  nativeblocks: 'native',
  'native-blocks': 'native',
  style: 'style',
  styleledger: 'style',
  'style-ledger': 'style',
  warnings: 'warnings',
  build: 'build',
  editor: 'editor',
  frontend: 'frontend',
  pattern: 'pattern',
  fidelity: 'fidelity',
  accessibility: 'accessibility',
};

export interface SourceIdentity {
  producer?: string;
  style?: string;
  path?: string;
  sha256?: string;
}

/** A declaration in a fixture. It describes a required check but is never a result. */
export interface DimensionAssertion {
  required?: boolean;
  description?: string;
  /** Optional implementation-specific expectations retained in the receipt. */
  [key: string]: unknown;
}

export type DimensionAssertions = Partial<Record<AuthoringDimension | 'nativeBlocks' | 'styleLedger', boolean | DimensionAssertion>>;

export interface AuthoringFixture {
  id: string;
  family: string;
  producer?: string;
  sourceStyle?: string;
  source?: SourceIdentity;
  prompt?: string;
  plan?: string;
  guide?: string;
  template?: string;
  dependency?: unknown;
  wordpress?: unknown;
  theme?: unknown;
  browser?: unknown;
  /** Preferred fixture contract: keys name dimensions that must be measured. */
  assertions?: DimensionAssertions;
  /** Alias used by early corpus drafts. */
  dimensions?: DimensionAssertions;
  requiredDimensions?: readonly (AuthoringDimension | 'nativeBlocks' | 'styleLedger')[];
  expectedStatus?: ExpectedStatus;
  disposition?: {
    kind?: 'scored' | 'expected-negative';
    expectedStatus?: ExpectedStatus;
  };
  candidate?: {
    /** Path to a JSON receipt, relative to the suite directory unless absolute. */
    receipt?: string;
    artifactRoot?: string;
    requiredFiles?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AuthoringSuite {
  version?: string;
  contract?: string;
  fixtures: AuthoringFixture[];
  prompt?: string;
  guide?: string;
  template?: string;
  dependency?: unknown;
  wordpress?: unknown;
  theme?: unknown;
  browser?: unknown;
  environment?: {
    wordpress?: unknown;
    theme?: unknown;
    browser?: unknown;
  };
  [key: string]: unknown;
}

export interface ReceiptCheck {
  pass?: boolean;
  score?: number;
  detail?: string;
  /** Immutable artifacts produced by the gate, never a free-form pass claim. */
  evidence?: ReceiptArtifact | ReceiptArtifact[];
}

export type ReceiptChecks = Partial<Record<AuthoringDimension | 'nativeBlocks' | 'styleLedger', boolean | number | ReceiptCheck>>;

/**
 * A receipt is generated after running the candidate through its actual gates.
 * `checks` and `dimensions` are aliases so runners can retain their native
 * terminology.  A receipt may only claim `scored` after all relevant gates ran.
 */
export interface AuthoringReceipt {
  schemaVersion?: number;
  fixtureId?: string;
  status?: AuthoringStatus;
  checks?: ReceiptChecks;
  dimensions?: ReceiptChecks;
  error?: {
    kind?: 'model' | 'tool' | 'engine' | string;
    message?: string;
  };
  warnings?: string[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  timingMethod?: string;
  provenance?: Record<string, unknown>;
  artifacts?: Record<string, ReceiptArtifact>;
  failClosed?: {
    warningCode?: string;
    noInteractiveRuntime?: boolean;
    evidence?: ReceiptArtifact | ReceiptArtifact[];
  };
  [key: string]: unknown;
}

export interface ReceiptArtifact {
  path: string;
  sha256: string;
}

export interface DimensionScore {
  /** null means the dimension was not measured (never a product zero). */
  score: number | null;
  required: boolean;
  pass: boolean | null;
  detail?: string;
}

export interface FixtureScore {
  id: string;
  family: string;
  source: SourceIdentity;
  expectedStatus: ExpectedStatus;
  status: AuthoringStatus;
  /** False for expected-negative fixtures that fail open or for failed checks. */
  contractPass: boolean;
  /** Model/tool/engine errors invalidate a measurement and are excluded from reports. */
  validMeasurement: boolean;
  dimensions: Record<AuthoringDimension, DimensionScore>;
  failures: string[];
  receipt?: Pick<AuthoringReceipt, 'startedAt' | 'durationMs' | 'timingMethod'>;
}

export interface RunSummary {
  fixtures: number;
  scored: number;
  unsupported: number;
  blocked: number;
  engineErrors: number;
  invalidMeasurements: number;
  contractPass: boolean;
}

export interface AuthoringRun {
  contract: string;
  hashes: AuthoringHashes;
  scores: FixtureScore[];
  summary: RunSummary;
  metadata: RunMetadata;
}

export interface RunMetadata {
  workload?: string;
  model?: string;
  effort?: string;
  timingMethod?: string;
  startedAt?: string;
}

/** All provenance values are independently hashed; none is folded into suiteHash. */
export interface AuthoringHashes {
  /** Hash of all versioned corpus inputs, verified against hashes.json. */
  corpusHash: string;
  suiteHash: string;
  fixtureManifestHash: string;
  sourceSetHash: string;
  sourceDependencyHash: string;
  expectedPlanHash: string;
  scorerHash: string;
  promptHash: string;
  guideHash: string;
  /** Compatibility field for the release provenance template. */
  promptGuideHash: string;
  templateHash: string;
  dependencyHash: string;
  wordpressHash: string;
  themeHash: string;
  browserHash: string;
}

export interface HashInputs {
  prompt?: unknown;
  guide?: unknown;
  template?: unknown;
  dependency?: unknown;
  wordpress?: unknown;
  theme?: unknown;
  browser?: unknown;
}

/** Deterministic JSON suitable for provenance hashes. Arrays retain their meaningful order. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function sha256(value: unknown): string {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

export function hashFile(file: string): string {
  return existsSync(file) ? sha256(readFileSync(file, 'utf8')) : sha256({ absent: path.resolve(file) });
}

function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

/**
 * Content-address a corpus tree as path/hash pairs.  This keeps expected plans,
 * source dependencies, and configuration files in run provenance even when a
 * fixture index itself did not change.
 */
function treeHash(directory: string, include: (relative: string) => boolean): string {
  return sha256(
    filesBelow(directory)
      .map((file) => path.relative(directory, file).split(path.sep).join('/'))
      .filter(include)
      .sort()
      .map((relative) => ({ path: relative, sha256: hashFile(path.join(directory, relative)).replace(/^sha256:/, '') })),
  );
}

function manifestValue(directory: string, key: string): string | undefined {
  const manifest = path.join(directory, 'hashes.json');
  if (!existsSync(manifest)) return undefined;
  try {
    const values = JSON.parse(readFileSync(manifest, 'utf8')).values as Record<string, unknown> | undefined;
    const value = values?.[key];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') return (value as { value: string }).value;
  } catch {
    return undefined;
  }
  return undefined;
}

/** The checked-in manifest is part of the contract, so reject stale manifests. */
export function corpusHashes(directory: string): Pick<AuthoringHashes, 'corpusHash' | 'fixtureManifestHash' | 'sourceSetHash' | 'sourceDependencyHash' | 'expectedPlanHash'> {
  const normalizedDirectory = path.resolve(directory);
  const corpusHash = treeHash(normalizedDirectory, (relative) => relative !== 'hashes.json' && !relative.startsWith('runs/'));
  const fixtureManifestHash = treeHash(normalizedDirectory, (relative) =>
    relative === 'fixtures.json' || relative === 'suite.json' || relative === 'schema.json' || relative.startsWith('fixtures/'),
  );
  const sourceSetHash = treeHash(normalizedDirectory, (relative) => relative.startsWith('sources/'));
  const sourceDependencyHash = sha256(
    JSON.parse(readFileSync(path.join(normalizedDirectory, 'fixtures.json'), 'utf8')).fixtures.map((fixture: AuthoringFixture) => {
      const dependencies = [fixture.source, ...(Array.isArray(fixture.sourceDependencies) ? fixture.sourceDependencies : [])]
        .filter(isRecord)
        .map((dependency) => {
          const relative = typeof dependency.path === 'string' ? dependency.path : '';
          const source = path.resolve(normalizedDirectory, relative);
          return { path: relative, declaredHash: dependency.sha256, actualHash: hashFile(source) };
        });
      return { id: fixture.id, dependencies };
    }),
  );
  const expectedPlanHash = treeHash(normalizedDirectory, (relative) => relative.endsWith('/expected-plan.json'));
  const recorded = manifestValue(normalizedDirectory, 'suiteHash');
  if (recorded && recorded !== corpusHash.replace(/^sha256:/, '')) {
    throw new Error(`authoring corpus hash manifest is stale: hashes.json suiteHash=${recorded}, computed=${corpusHash.replace(/^sha256:/, '')}`);
  }
  return { corpusHash, fixtureManifestHash, sourceSetHash, sourceDependencyHash, expectedPlanHash };
}

/** Hash the scorer source itself so a changed formula cannot silently compare to old runs. */
export function scorerHash(): string {
  return sha256({
    scorer: hashFile(fileURLToPath(import.meta.url)),
    runner: hashFile(path.join(ROOT, 'scripts', 'authoring-runner.ts')),
  });
}

export function suiteHash(suite: AuthoringSuite): string {
  // Provenance values are deliberately omitted: they have their own independent hashes.
  const { prompt: _prompt, guide: _guide, template: _template, dependency: _dependency, wordpress: _wordpress, theme: _theme, browser: _browser, ...contract } = suite;
  return sha256(contract);
}

function fileBacked(value: unknown, directory: string): unknown {
  if (typeof value !== 'string') return value;
  const file = path.resolve(directory, value);
  if (!file.startsWith(`${path.resolve(directory)}${path.sep}`) || !existsSync(file)) return value;
  return { path: value, contents: readFileSync(file, 'utf8') };
}

function hashInput(value: unknown, directory: string): string {
  if (Array.isArray(value)) return sha256(value.map((item) => fileBacked(item, directory)));
  return sha256(fileBacked(value, directory));
}

export function authoringHashes(suite: AuthoringSuite, inputs: HashInputs = {}): AuthoringHashes {
  const environment = suite.environment ?? {};
  const directory = SUITE_DIRECTORIES.get(suite) ?? path.join(ROOT, 'benchmarks', 'authoring');
  const prompt = inputs.prompt ?? suite.prompt ?? suite.fixtures.map((fixture) => fixture.prompt ?? null);
  // The corpus guide is the contract plus the concise README unless a suite supplies one.
  const guide = inputs.guide ?? suite.guide ?? ['contract.md', 'README.md', ...suite.fixtures.map((fixture) => fixture.guide ?? null)];
  const template = inputs.template ?? suite.template ?? 'candidate-contract.json';
  const dependency = inputs.dependency ?? suite.dependency;
  const wordpress = inputs.wordpress ?? suite.wordpress ?? environment.wordpress ?? suite.fixtures.map((fixture) => fixture.wordpress ?? null);
  const theme = inputs.theme ?? suite.theme ?? environment.theme ?? suite.fixtures.map((fixture) => fixture.theme ?? null);
  const browser = inputs.browser ?? suite.browser ?? environment.browser ?? suite.fixtures.map((fixture) => fixture.browser ?? null);
  const corpus = corpusHashes(directory);
  return {
    ...corpus,
    // Retain suiteHash for consumers of the initial contract, but bind it to
    // the full corpus rather than only the in-memory suite index.
    suiteHash: corpus.corpusHash,
    scorerHash: scorerHash(),
    promptHash: hashInput(prompt, directory),
    guideHash: hashInput(guide, directory),
    promptGuideHash: sha256({ prompt: hashInput(prompt, directory), guide: hashInput(guide, directory) }),
    templateHash: hashInput(template, directory),
    dependencyHash: dependency === undefined ? hashFile(path.join(ROOT, 'package-lock.json')) : hashInput(dependency, directory),
    wordpressHash: hashInput(wordpress, directory),
    themeHash: hashInput(theme, directory),
    browserHash: hashInput(browser, directory),
  };
}

function normalizedDimension(key: string): AuthoringDimension | undefined {
  return DIMENSION_ALIASES[key.toLowerCase()];
}

function assertionsFor(fixture: AuthoringFixture): Map<AuthoringDimension, DimensionAssertion> {
  const assertions = new Map<AuthoringDimension, DimensionAssertion>();
  const add = (key: string, value: boolean | DimensionAssertion | undefined): void => {
    const dimension = normalizedDimension(key);
    if (!dimension) return;
    assertions.set(dimension, typeof value === 'boolean' ? { required: value } : { required: true, ...value });
  };

  for (const [key, value] of Object.entries(fixture.assertions ?? {})) add(key, value);
  for (const [key, value] of Object.entries(fixture.dimensions ?? {})) {
    const dimension = normalizedDimension(key);
    if (dimension && !assertions.has(dimension)) add(key, value);
  }
  for (const dimension of fixture.requiredDimensions ?? []) add(dimension, true);
  return assertions;
}

function expectedStatusFor(fixture: AuthoringFixture): ExpectedStatus {
  return fixture.expectedStatus ?? fixture.disposition?.expectedStatus ?? (fixture.disposition?.kind === 'expected-negative' ? 'unsupported' : 'scored');
}

function normalizeCheck(value: boolean | number | ReceiptCheck | undefined): { score: number; pass: boolean; detail?: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return { score: value ? 100 : 0, pass: value };
  if (typeof value === 'number') {
    const score = value <= 1 ? value * 100 : value;
    return { score: Math.max(0, Math.min(100, score)), pass: score >= 100 };
  }
  const score = value.score === undefined ? (value.pass === false ? 0 : 100) : value.score <= 1 ? value.score * 100 : value.score;
  const bounded = Math.max(0, Math.min(100, score));
  return { score: bounded, pass: value.pass ?? bounded >= 100, detail: value.detail };
}

function checksFor(receipt: AuthoringReceipt): Map<AuthoringDimension, boolean | number | ReceiptCheck> {
  const checks = new Map<AuthoringDimension, boolean | number | ReceiptCheck>();
  for (const [key, value] of Object.entries({ ...(receipt.dimensions ?? {}), ...(receipt.checks ?? {}) })) {
    const dimension = normalizedDimension(key);
    if (dimension && value !== undefined) checks.set(dimension, value);
  }
  return checks;
}

function resultStatus(receipt: AuthoringReceipt | undefined): AuthoringStatus {
  if (!receipt) return 'blocked';
  if (receipt.status === 'engine_error' || (receipt.status as string) === 'engine-error') return 'engine_error';
  if (receipt.error?.kind === 'model' || receipt.error?.kind === 'tool' || receipt.error?.kind === 'engine') return 'engine_error';
  return receipt.status ?? 'blocked';
}

/**
 * Score an already-collected receipt. Product dimensions are only populated for
 * `scored` receipts; unsupported, blocked, and engine-error outcomes use nulls
 * to preserve the distinction in JSON and in reports.
 */
export function scoreAuthoringFixture(fixture: AuthoringFixture, receipt?: AuthoringReceipt): FixtureScore {
  const expectedStatus = expectedStatusFor(fixture);
  const status = resultStatus(receipt);
  const requirements = assertionsFor(fixture);
  const checks = receipt ? checksFor(receipt) : new Map<AuthoringDimension, boolean | number | ReceiptCheck>();
  const dimensions = {} as Record<AuthoringDimension, DimensionScore>;
  const failures: string[] = [];

  for (const dimension of AUTHORING_DIMENSIONS) {
    const assertion = requirements.get(dimension);
    const required = assertion?.required !== false && assertion !== undefined;
    if (status !== 'scored') {
      dimensions[dimension] = { score: null, required, pass: null };
      continue;
    }
    const raw = checks.get(dimension);
    const actual = normalizeCheck(raw);
    if (!required && !actual) {
      dimensions[dimension] = { score: null, required: false, pass: null };
      continue;
    }
    if (!actual) {
      dimensions[dimension] = { score: 0, required, pass: false, detail: 'receipt did not record this check' };
      if (required) failures.push(`${dimension}: required check missing from receipt`);
      continue;
    }
    if (!isRecord(raw) || !evidenceArtifacts((raw as ReceiptCheck).evidence).length) {
      dimensions[dimension] = { score: actual.score, required, pass: false, detail: 'receipt check has no retained evidence' };
      if (required) failures.push(`${dimension}: receipt check has no retained evidence`);
      continue;
    }
    dimensions[dimension] = { score: actual.score, required, pass: actual.pass, detail: actual.detail };
    if (required && !actual.pass) failures.push(`${dimension}: ${actual.detail ?? 'assertion failed'}`);
  }

  if (status === 'engine_error') {
    failures.push(`invalid measurement: ${receipt?.error?.kind ?? 'engine'} error${receipt?.error?.message ? ` — ${receipt.error.message}` : ''}`);
  } else if (status !== expectedStatus) {
    failures.push(`expected status ${expectedStatus}, received ${status}`);
  }
  if (status === 'unsupported' && expectedStatus === 'unsupported') {
    const warning = checks.get('warnings');
    const warningHasEvidence = isRecord(warning) && (warning as ReceiptCheck).pass === true && evidenceArtifacts((warning as ReceiptCheck).evidence).length > 0;
    const expectedCode = requiredWarningCode(fixture);
    const failClosed = receipt?.failClosed;
    if (!warningHasEvidence || !failClosed || failClosed.noInteractiveRuntime !== true || (expectedCode && failClosed.warningCode !== expectedCode) || !evidenceArtifacts(failClosed.evidence).length) {
      failures.push('unsupported result lacks warning and fail-closed evidence');
    }
  }

  const checksPass = status !== 'scored' || [...requirements.keys()].every((dimension) => dimensions[dimension].pass === true);
  // All non-scored statuses are explicitly excluded from product figures. An
  // expected-negative unsupported fixture may still pass the suite contract.
  const validMeasurement = status === 'scored';

  return {
    id: fixture.id,
    family: fixture.family,
    source: {
      producer: fixture.source?.producer ?? fixture.producer,
      style: fixture.source?.style ?? fixture.sourceStyle,
      path: fixture.source?.path,
      sha256: fixture.source?.sha256,
    },
    expectedStatus,
    status,
    contractPass: status !== 'engine_error' && status === expectedStatus && checksPass && failures.length === 0,
    validMeasurement,
    dimensions,
    failures,
    receipt: receipt ? { startedAt: receipt.startedAt, durationMs: receipt.durationMs, timingMethod: receipt.timingMethod } : undefined,
  };
}

export function summarizeAuthoringScores(scores: readonly FixtureScore[]): RunSummary {
  const count = (status: AuthoringStatus): number => scores.filter((score) => score.status === status).length;
  return {
    fixtures: scores.length,
    scored: count('scored'),
    unsupported: count('unsupported'),
    blocked: count('blocked'),
    engineErrors: count('engine_error'),
    invalidMeasurements: scores.filter((score) => !score.validMeasurement).length,
    contractPass: scores.length > 0 && scores.every((score) => score.contractPass),
  };
}

const HASH = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function evidenceArtifacts(value: unknown): ReceiptArtifact[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.filter(
    (entry): entry is ReceiptArtifact =>
      isRecord(entry) && typeof entry.path === 'string' && typeof entry.sha256 === 'string',
  );
}

function artifactFailure(artifact: ReceiptArtifact, receiptDirectory: string): string | undefined {
  if (!artifact.path || path.isAbsolute(artifact.path)) return `artifact path must be relative: ${artifact.path}`;
  if (!HASH.test(artifact.sha256)) return `artifact hash is invalid: ${artifact.path}`;
  const root = path.resolve(receiptDirectory);
  const file = path.resolve(root, artifact.path);
  if (!file.startsWith(`${root}${path.sep}`)) return `artifact path escapes receipt directory: ${artifact.path}`;
  if (!existsSync(file) || !statSync(file).isFile()) return `artifact is missing: ${artifact.path}`;
  if (hashFile(file) !== artifact.sha256) return `artifact hash mismatch: ${artifact.path}`;
  return undefined;
}

function requiredWarningCode(fixture: AuthoringFixture): string | undefined {
  const warnings = fixture.assertions?.warnings;
  if (!isRecord(warnings) || !Array.isArray(warnings.expectedCodes)) return undefined;
  return warnings.expectedCodes.find((code): code is string => typeof code === 'string');
}

/**
 * Validate an execution receipt before it becomes score input.  The scorer is
 * deliberately strict: a boolean does not prove a browser/editor gate ran.
 * This is the runtime counterpart of `receipt.schema.json`; it additionally
 * resolves every declared artifact and verifies its content hash.
 */
export function validateAuthoringReceipt(
  fixture: AuthoringFixture,
  receipt: AuthoringReceipt,
  suiteDirectory: string,
  receiptDirectory: string,
): string[] {
  const failures: string[] = [];
  const requireString = (key: keyof AuthoringReceipt): void => {
    if (typeof receipt[key] !== 'string' || !(receipt[key] as string).trim()) failures.push(`receipt requires ${String(key)}`);
  };
  if (receipt.schemaVersion !== 1) failures.push('receipt schemaVersion must be 1');
  if (receipt.fixtureId !== fixture.id) failures.push(`receipt fixtureId must equal ${fixture.id}`);
  if (!['scored', 'unsupported', 'blocked', 'engine_error'].includes(receipt.status ?? '')) failures.push('receipt has an invalid status');
  requireString('startedAt');
  requireString('finishedAt');
  requireString('timingMethod');
  if (typeof receipt.durationMs !== 'number' || !Number.isFinite(receipt.durationMs) || receipt.durationMs < 0) {
    failures.push('receipt requires a non-negative durationMs');
  }
  if (receipt.timingMethod !== 'monotonic-wall-clock-source-materialization-through-receipt-write') {
    failures.push('receipt timingMethod is not the corpus timing method');
  }
  for (const timestamp of [receipt.startedAt, receipt.finishedAt]) {
    if (typeof timestamp === 'string' && Number.isNaN(Date.parse(timestamp))) failures.push(`receipt timestamp is invalid: ${timestamp}`);
  }

  const provenance = receipt.provenance;
  if (!isRecord(provenance)) {
    failures.push('receipt requires provenance');
  } else {
    let hashes: AuthoringHashes | undefined;
    try {
      const suite = loadAuthoringSuite(suiteDirectory);
      hashes = authoringHashes(suite);
    } catch (error) {
      failures.push(`could not validate corpus provenance: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const key of [
      'corpusHash',
      'suiteHash',
      'fixtureManifestHash',
      'sourceSetHash',
      'sourceDependencyHash',
      'expectedPlanHash',
      'scorerHash',
      'promptGuideHash',
      'templateHash',
      'dependencyHash',
      'wordpressHash',
      'themeHash',
      'browserHash',
      'generatedSourceHash',
    ]) {
      const value = provenance[key];
      if (typeof value !== 'string' || !HASH.test(value)) failures.push(`receipt provenance requires hash ${key}`);
      else if (hashes && key !== 'generatedSourceHash' && key in hashes && value !== hashes[key as keyof AuthoringHashes]) {
        failures.push(`receipt provenance ${key} does not match this corpus`);
      }
    }
    for (const key of ['model', 'effort']) {
      if (typeof provenance[key] !== 'string' || !provenance[key].trim()) failures.push(`receipt provenance requires ${key}`);
    }
    const expectedSourceHash = fixture.source?.sha256 ? `sha256:${fixture.source.sha256.replace(/^sha256:/, '')}` : undefined;
    if (expectedSourceHash && provenance.sourceHash !== expectedSourceHash) failures.push('receipt provenance sourceHash does not match fixture source');
  }

  const artifacts = receipt.artifacts;
  const knownArtifacts = new Map<string, ReceiptArtifact>();
  if (!isRecord(artifacts) || !Object.keys(artifacts).length) {
    failures.push('receipt requires retained artifacts');
  } else {
    for (const [name, value] of Object.entries(artifacts)) {
      if (!isRecord(value) || typeof value.path !== 'string' || typeof value.sha256 !== 'string') {
        failures.push(`artifact ${name} is not a path/hash object`);
        continue;
      }
      const artifact = value as ReceiptArtifact;
      knownArtifacts.set(artifact.path, artifact);
      const failure = artifactFailure(artifact, receiptDirectory);
      if (failure) failures.push(failure);
    }
    if (!artifacts.generatedSourceManifest) failures.push('receipt requires generatedSourceManifest artifact');
  }
  if (isRecord(provenance) && isRecord(artifacts) && isRecord(artifacts.generatedSourceManifest)) {
    const generated = artifacts.generatedSourceManifest as ReceiptArtifact;
    if (provenance.generatedSourceHash !== generated.sha256) failures.push('generatedSourceHash must equal generatedSourceManifest hash');
  }

  const requirements = assertionsFor(fixture);
  const receiptChecks = receipt.checks;
  const check = (dimension: AuthoringDimension): ReceiptCheck | undefined => {
    const value = receiptChecks?.[dimension] ?? receipt.dimensions?.[dimension];
    return isRecord(value) ? (value as ReceiptCheck) : undefined;
  };
  const evidenceFor = (dimension: AuthoringDimension): void => {
    const value = check(dimension);
    const evidence = evidenceArtifacts(value?.evidence);
    if (!value || typeof value.pass !== 'boolean') {
      failures.push(`${dimension} check must be an object with an explicit pass value`);
      return;
    }
    if (!evidence.length) {
      failures.push(`${dimension} check requires retained evidence`);
      return;
    }
    for (const artifact of evidence) {
      if (!knownArtifacts.has(artifact.path)) failures.push(`${dimension} evidence is not declared in receipt artifacts: ${artifact.path}`);
      else if (knownArtifacts.get(artifact.path)?.sha256 !== artifact.sha256) failures.push(`${dimension} evidence hash does not match declared artifact: ${artifact.path}`);
    }
  };

  if (receipt.status === 'scored') {
    for (const dimension of requirements.keys()) evidenceFor(dimension);
  }
  if (fixture.expectedStatus === 'unsupported' && receipt.status === 'unsupported') {
    evidenceFor('warnings');
    const failClosed = receipt.failClosed;
    const expectedCode = requiredWarningCode(fixture);
    if (!failClosed || failClosed.noInteractiveRuntime !== true || (expectedCode && failClosed.warningCode !== expectedCode)) {
      failures.push('unsupported receipt must prove the required warning and absence of interactive runtime');
    }
    const evidence = evidenceArtifacts(failClosed?.evidence);
    if (!evidence.length) failures.push('unsupported receipt requires fail-closed evidence');
    for (const artifact of evidence) {
      if (!knownArtifacts.has(artifact.path)) failures.push(`fail-closed evidence is not declared in receipt artifacts: ${artifact.path}`);
    }
    const readEvidence = (items: ReceiptArtifact[]): string =>
      items
        .map((artifact) => {
          const root = path.resolve(receiptDirectory);
          const file = path.resolve(root, artifact.path);
          return file.startsWith(`${root}${path.sep}`) && existsSync(file) ? readFileSync(file, 'utf8') : '';
        })
        .join('\n');
    const warningEvidence = evidenceArtifacts(check('warnings')?.evidence);
    if (expectedCode && !readEvidence(warningEvidence).includes(expectedCode)) {
      failures.push(`warning evidence does not contain required code ${expectedCode}`);
    }
    if (!readEvidence(evidence).includes('noInteractiveRuntime')) {
      failures.push('fail-closed evidence does not prove noInteractiveRuntime');
    }
  }
  return failures;
}

/**
 * Reads one receipt per fixture. A runner may instead call scoreAuthoringFixture
 * directly after invoking WordPress/browser/package gates itself.
 */
export function receiptForFixture(fixture: AuthoringFixture, suiteDirectory: string): AuthoringReceipt | undefined {
  const relative = fixture.candidate?.receipt;
  if (!relative) return undefined;
  const receipt = path.isAbsolute(relative) ? relative : path.resolve(suiteDirectory, relative);
  if (!existsSync(receipt)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(receipt, 'utf8')) as AuthoringReceipt;
    const failures = validateAuthoringReceipt(fixture, parsed, suiteDirectory, path.dirname(receipt));
    if (!failures.length) return parsed;
    return {
      status: 'engine_error',
      error: { kind: 'engine', message: `receipt ${relative} failed schema/evidence validation: ${failures.join('; ')}` },
    };
  } catch (error) {
    return {
      status: 'engine_error',
      error: { kind: 'engine', message: `could not parse receipt ${relative}: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
}

/**
 * Check immutable fixture input and generated-file contracts before trusting a
 * completed receipt. These checks are intentionally local: they do not claim
 * that an editor, browser, or visual gate ran; those remain receipt evidence.
 */
export function fixtureContractFailures(fixture: AuthoringFixture, suiteDirectory: string): string[] {
  const failures: string[] = [];
  const sourcePath = fixture.source?.path;
  if (sourcePath) {
    const source = path.resolve(suiteDirectory, sourcePath);
    if (!existsSync(source)) failures.push(`source file missing: ${sourcePath}`);
    else if (fixture.source?.sha256) {
      const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
      const expected = fixture.source.sha256.replace(/^sha256:/, '');
      if (actual !== expected) failures.push(`source hash mismatch: ${sourcePath}`);
    }
  }
  const dependencies = Array.isArray(fixture.sourceDependencies) ? fixture.sourceDependencies : [];
  for (const dependency of dependencies) {
    if (!isRecord(dependency) || typeof dependency.path !== 'string' || typeof dependency.sha256 !== 'string') {
      failures.push(`invalid source dependency declaration for ${fixture.id}`);
      continue;
    }
    const source = path.resolve(suiteDirectory, dependency.path);
    if (!existsSync(source)) failures.push(`source dependency missing: ${dependency.path}`);
    else {
      const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
      if (actual !== dependency.sha256.replace(/^sha256:/, '')) failures.push(`source dependency hash mismatch: ${dependency.path}`);
    }
  }
  if (fixture.plan) {
    const plan = path.resolve(suiteDirectory, fixture.plan);
    if (!existsSync(plan)) failures.push(`expected plan missing: ${fixture.plan}`);
  }
  const artifactRoot = fixture.candidate?.artifactRoot;
  if (artifactRoot) {
    const root = path.isAbsolute(artifactRoot) ? artifactRoot : path.resolve(suiteDirectory, artifactRoot);
    for (const relative of fixture.candidate?.requiredFiles ?? []) {
      if (!existsSync(path.resolve(root, relative))) failures.push(`generated file missing: ${path.join(artifactRoot, relative)}`);
    }
  }
  return failures;
}

function receiptWithFixtureContract(fixture: AuthoringFixture, suiteDirectory: string): AuthoringReceipt | undefined {
  const receipt = receiptForFixture(fixture, suiteDirectory);
  if (!receipt || resultStatus(receipt) !== 'scored') return receipt;
  const failures = fixtureContractFailures(fixture, suiteDirectory);
  if (!failures.length) return receipt;
  return {
    ...receipt,
    checks: {
      ...(receipt.checks ?? {}),
      source: { pass: false, score: 0, detail: failures.join('; ') },
    },
  };
}

export function scoreAuthoringSuite(suite: AuthoringSuite, suiteDirectory: string, metadata: RunMetadata = {}): AuthoringRun {
  const scores = suite.fixtures.map((fixture) => scoreAuthoringFixture(fixture, receiptWithFixtureContract(fixture, suiteDirectory)));
  return {
    contract: AUTHORING_BENCHMARK_CONTRACT,
    hashes: authoringHashes(suite),
    scores,
    summary: summarizeAuthoringScores(scores),
    metadata,
  };
}

/** Human-readable label required beside every published benchmark figure. */
export function publishedFigureLabel(run: Pick<AuthoringRun, 'summary' | 'metadata'>): string {
  const metadata = run.metadata;
  return [
    `workload=${metadata.workload ?? 'unreported'}`,
    `suite_size=${run.summary.fixtures}`,
    `model=${metadata.model ?? 'unreported'}`,
    `effort=${metadata.effort ?? 'unreported'}`,
    `invalid=${run.summary.invalidMeasurements}`,
    `timing=${metadata.timingMethod ?? 'unreported'}`,
  ].join('; ');
}

/**
 * Accepts either `fixtures.json`, `suite.json`, or one fixture JSON per file in
 * `fixtures/`. Duplicate fixture ids are rejected so a suite cannot silently
 * replace a result.  This keeps corpus definitions easy to inspect and review.
 */
export function loadAuthoringSuite(directory = path.join(ROOT, 'benchmarks', 'authoring')): AuthoringSuite {
  let suite: AuthoringSuite = { contract: AUTHORING_BENCHMARK_CONTRACT, fixtures: [] };
  // `suite.json` carries environment/provenance while `fixtures.json` carries
  // the fixture index. Read both when present; neither silently replaces the
  // other (the first implementation of this loader accidentally did that).
  for (const name of ['suite.json', 'fixtures.json']) {
    const file = path.join(directory, name);
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as AuthoringSuite | AuthoringFixture[];
    if (Array.isArray(parsed)) {
      suite = { ...suite, fixtures: [...suite.fixtures, ...parsed] };
    } else {
      suite = { ...suite, ...parsed, fixtures: parsed.fixtures ?? suite.fixtures };
    }
  }

  const fixtureDirectory = path.join(directory, 'fixtures');
  if (existsSync(fixtureDirectory)) {
    const files = jsonFiles(fixtureDirectory).filter((file) => path.basename(file) === 'fixture.json' || file.endsWith('.fixture.json'));
    const byId = new Map(suite.fixtures.map((fixture) => [fixture.id, fixture]));
    for (const file of files) {
      // fixtures.json is sometimes mirrored below fixtures; avoid reading that suite as one fixture.
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as AuthoringFixture | AuthoringSuite;
      const fixtures = Array.isArray((parsed as AuthoringSuite).fixtures) ? (parsed as AuthoringSuite).fixtures : [parsed as AuthoringFixture];
      for (const fixture of fixtures) {
        const existing = byId.get(fixture.id);
        if (!existing) {
          suite.fixtures.push(fixture);
          byId.set(fixture.id, fixture);
        } else if (canonicalJson(existing) !== canonicalJson(fixture)) {
          throw new Error(`duplicate authoring fixture id with different contract: ${fixture.id}`);
        }
      }
    }
  }

  const ids = new Set<string>();
  for (const fixture of suite.fixtures) {
    if (!fixture.id || !fixture.family) throw new Error('authoring fixture requires non-empty id and family');
    if (ids.has(fixture.id)) throw new Error(`duplicate authoring fixture id: ${fixture.id}`);
    ids.add(fixture.id);
  }
  SUITE_DIRECTORIES.set(suite, path.resolve(directory));
  return suite;
}

function jsonFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...jsonFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.json')) found.push(file);
  }
  return found;
}
