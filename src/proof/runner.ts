import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { validate } from '../gate/validate.js';
import { PROOF_IMAGE_BASE64 } from './fixture-image.js';
import {
  PROOF_GATE_IDS,
  PROOF_PROFILES,
  evaluateProofProfile,
  type ProofGateId,
  type ProofGateRecord,
  type ProofGateStatus,
  type ProofProfileName,
  type ProofProfileReport,
} from './profiles.js';
import {
  EvidenceStore,
  ReceiptWriter,
  sha256 as hashBytes,
  type EvidenceReference,
  type ReceiptReference,
  type Sha256,
} from './receipt.js';

const projectRoot = resolveProjectRoot(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const defaultWpEnvConfig = path.join(projectRoot, 'proof', 'wp-env.json');
const playwrightHelper = path.join(projectRoot, 'scripts', 'proof-playwright.mjs');
const stagedZipDirectory = path.join(projectRoot, '.block-runner-proof-stage');
// Keep staging outside uploads: a nested Docker mount can create its parent as
// root on a fresh Linux host, preventing WordPress from creating media folders.
const stagedZipContainerDirectory = '/var/www/html/wp-content/block-runner-proof';
const REQUIRED_WORDPRESS_VERSION = '7.1' as const;
const REQUIRED_WORDPRESS_CORE_SOURCE = 'WordPress/WordPress#7.1' as const;
const REQUIRED_PHP_SERIES = '8.3' as const;
const RUNTIME_OBSERVATION_COMMANDS = [
  'php',
  'database',
  'theme',
  'themeHash',
  'wordpress',
  'coreHash',
  'wordpressContainer',
  'databaseContainer',
  'wordpressImage',
  'databaseImage',
] as const;

export interface WordPressPackagePin {
  /** Exact version resolved from package-lock.json. */
  version: string;
  /** npm Subresource Integrity value resolved from package-lock.json. */
  integrity: string;
}
const PROOF_COMMAND_TIMEOUTS = {
  docker: 15_000,
  wpEnvStart: 180_000,
  wpEnv: 45_000,
  browser: 180_000,
} as const;

/** Editable surfaces supplied by the generated-block compiler or a fixture. */
export type ProofEditableSurface = 'richText' | 'media' | 'link' | 'altText';

export interface ProofEditableField {
  path: string;
  surface: ProofEditableSurface;
  /** Exact native metadata.name; required when the inserted block contains competing fields. */
  metadataName?: string;
  /** A real, prepared Media Library selection for a media field. */
  media?: { id: number; url: string; alt: string };
  /** A stable selector may be supplied when a block has a custom editor UI. */
  selector?: string;
  /** The value the browser proof must persist. */
  value?: string;
}

/** The exact per-instance map WordPress stores at core/block.attributes.content. */
export type PatternOverrideContent = Record<string, Record<string, unknown>>;

export interface ProofPatternInstance {
  /** Human-readable identity used only in receipts. */
  label: string;
  /** Distinct local values keyed by a child block's metadata.name. */
  content: PatternOverrideContent;
}

export interface ProofPatternRequiredBinding {
  name: string;
  attribute: string;
}

export interface ProofPatternNegativeBinding extends ProofPatternRequiredBinding {
  /** Value entered through the native control of a deliberately deficient pattern. */
  value: string;
  /** Canonical value which must render after the deficient edit is discarded. */
  fallback: string;
}
/**
 * Assertions which belong to a particular generated block. This deliberately
 * accepts the compiler's simple `editableFields` inventory without importing
 * an authoring implementation from another package/branch.
 */
export interface ProofFixture {
  blockName: string;
  /** Plugin archive slug when it differs from the block slug. */
  pluginSlug?: string;
  /** @deprecated The runner always uses the post it creates and publishes. */
  postId?: number;
  blockTitle?: string;
  editableFields?: readonly ProofEditableField[];
  patternOverrides?: {
    /** Exact pattern title inserted through the visible inserter. */
    title: string;
    /**
     * Canonical wp_block.post_content. It must contain only native
     * core/pattern-overrides bindings for the required child attributes.
     */
    canonicalContent: string;
    /** Two independently inserted core/block references with local values. */
    instances: readonly [ProofPatternInstance, ProofPatternInstance];
    /** A canonical-only layout/style update made through the core patterns REST route. */
    canonicalUpdate: {
      content: string;
      /** A visible marker that must reach both frontend instances. */
      marker: string;
    };
    /** Remove this one local value and verify WordPress falls back to canonical content. */
    reset: {
      instance: 0 | 1;
      name: string;
      attribute: string;
      fallback: string;
    };
    /** Required Core child bindings; omission is a failing negative, never a pass. */
    requiredBindings: readonly ProofPatternRequiredBinding[];
    /** The compiler's confirmed structural policy. */
    structuralPolicy: 'all' | 'contentOnly';
    /**
     * Required negative: the runner saves a separate deficient wp_block,
     * drives its native control, and proves its value cannot persist/render.
     */
    negative: ProofPatternNegativeBinding;
    /** Observed at runtime; never supplied by a fixture. */
    ref?: number;
    /** Exact wp_block.post_content read after WordPress saves the canonical pattern. */
    storedCanonicalContent?: string;
  };
  frontend?: {
    /** Required proof scope; navigation always uses the post published in this run. */
    url?: string;
    subtreeSelector?: string;
    expectedLinks?: readonly string[];
    expectedMedia?: readonly string[];
  };
  visual?: {
    /** Reviewed golden; the runner never changes this file. */
    expectedPath: string;
    /** A unique rendered design region; excludes unrelated theme/admin UI. */
    selector?: string;
    masks?: readonly string[];
    /** Fraction of differing pixels, from 0 to 1. */
    threshold: number;
  };
  accessibility?: {
    editorSelector?: string;
    frontendSelector?: string;
    /** A human result is recorded alongside Axe; Axe alone is not a WCAG claim. */
    manualReview: ProofGateStatus;
    /** JSON review record pinned to this exact input and plugin ZIP. A bare pass is not evidence. */
    manualReviewPath?: string;
  };
}

export interface ProofCommandResult {
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  phase?: string;
  durationMs?: number;
  timedOut?: boolean;
}

export interface ProofCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** A bounded command phase; defaults are applied by the built-in runner. */
  timeoutMs?: number;
  /** Included in immutable command evidence and concise proof progress logs. */
  phase?: string;
}

export type ProofCommandRunner = (command: string, args: readonly string[], options: ProofCommandOptions) => Promise<ProofCommandResult>;

export interface ProofGateResult {
  status: ProofGateStatus;
  reason?: string;
  details?: Record<string, unknown>;
  /** Additional immutable evidence captured by an adapter. */
  evidence?: readonly EvidenceReference[];
}

export interface ProofGateContext {
  profile: ProofProfileName;
  gate: ProofGateId;
  fixture?: ProofFixture;
  pluginZip?: string;
  wpEnvConfig: string;
  environment: ProofEnvironment;
  /** Persist an adapter's raw logs, JSON, screenshot, Axe response, etc. */
  capture: (value: string | Uint8Array | ArrayBuffer | Record<string, unknown>, mediaType?: string) => Promise<EvidenceReference>;
}

/**
 * An adapter boundary for CI and consumers that have their own authenticated
 * browser harness. It makes it impossible to turn an unrun browser action
 * into a pass: omitted required gates are recorded as `blocked`.
 */
export type ProofGateRunner = (context: ProofGateContext) => Promise<ProofGateResult | undefined>;

export interface ProofRunOptions {
  profile?: ProofProfileName;
  /** Built, installable static-plugin archive. Runtime profiles require it. */
  pluginZip?: string;
  /** Generator input bytes or a path to its reviewed input. */
  input?: string | Uint8Array;
  inputPath?: string;
  /** Post/block markup for the cheap headless Gutenberg validation gate. */
  markup?: string;
  fixture?: ProofFixture;
  /** Root for immutable `evidence/sha256` and `receipts/sha256` objects. */
  outputDir?: string;
  wpEnvConfig?: string;
  /** Defaults to true. Set false only for receipt-shape tests or dry diagnosis. */
  execute?: boolean;
  /** Keep wp-env alive after a real run. The default tears it down in a finally block. */
  keepEnvironment?: boolean;
  commandRunner?: ProofCommandRunner;
  gateRunner?: ProofGateRunner;
}

export interface ProofFilePin {
  path?: string;
  sha256: Sha256;
  bytes: number;
  evidence: EvidenceReference;
}

export interface ProofEnvironment {
  /** Raw command observations used to populate the runtime fields below. */
  observations?: EvidenceReference;
  generator: {
    package: string;
    version: string;
    packageJson: ProofFilePin;
    packageLock?: ProofFilePin;
  };
  plugin: {
    zip?: ProofFilePin;
    /** WordPress plugin metadata observed after the supplied ZIP is installed. */
    slug?: string;
    name?: string;
    version?: string;
    file?: string;
  };
  input?: ProofFilePin;
  wordpress: {
    requestedVersion: '7.1';
    /** Exact `core` source read from the pinned wp-env configuration. */
    coreSource: string;
    wpEnv: string;
    wpEnvConfig: ProofFilePin;
    version: string;
    coreHash: string;
    dockerImage?: string;
  };
  php: { requestedVersion: string; version: string };
  database: { engine: 'mysql' | 'mariadb'; image: string; version: string };
  theme: { name: string; version: string; fileHash: string };
  browser: { engine: 'chromium'; playwright: string; revision: string; version: string };
  node: { version: string };
  /** Exact, integrity-pinned direct @wordpress/* dependencies. */
  wordpressPackages: Record<string, WordPressPackagePin>;
}

export interface ProofReceiptDocument {
  schemaVersion: 1;
  kind: 'block-runner.wordpress-proof';
  createdAt: string;
  selectedProfile: ProofProfileName;
  ok: boolean;
  environment: ProofEnvironment;
  gates: ProofGateRecord[];
  profile: ProofProfileReport;
}

export interface ProofRunResult {
  ok: boolean;
  profile: ProofProfileReport;
  receipt: ProofReceiptDocument;
  receiptReference: ReceiptReference;
}

/** The post created, saved, reopened, and published by the browser helper. */
interface ProofPublication {
  id: number;
  permalink: string;
  savedContent: string;
  frontendAssets?: readonly { url: string; resourceType: string; status?: number; delivery?: 'inline'; contentHash?: string }[];
}

interface PreparedSyncedPattern {
  ref: number;
  canonicalContent: string;
  instances: readonly ProofPatternInstance[];
  negative: {
    ref: number;
    title: string;
    canonicalContent: string;
  };
}
/**
 * Run one cumulative proof profile and write a content-addressed receipt.
 *
 * `headless` runs entirely in Node. Higher profiles boot a pinned wp-env
 * Docker/MySQL environment, install the exact ZIP, then delegate browser work
 * to the bundled WordPress-Playwright helper. Any unavailable prerequisite is
 * a `blocked` gate, never a false green result.
 */
export async function runProof(options: ProofRunOptions): Promise<ProofRunResult> {
  const profile = options.profile ?? 'full';
  if (!(profile in PROOF_PROFILES)) {
    throw new TypeError(`Unknown proof profile: ${String(profile)}`);
  }

  const outputDir = path.resolve(options.outputDir ?? path.join(process.cwd(), 'proof-receipts'));
  const receiptWriter = new ReceiptWriter(outputDir);
  const evidence = receiptWriter.evidence;
  const wpEnvConfig = path.resolve(options.wpEnvConfig ?? defaultWpEnvConfig);
  const environment = await collectEnvironmentPins(options, evidence, wpEnvConfig);
  const runtime = createRuntime(options, environment, wpEnvConfig, evidence);
  const records: ProofGateRecord[] = [];

  try {
    for (const gate of PROOF_PROFILES[profile].requiredGates) {
      const startedAt = new Date().toISOString();
      const context: ProofGateContext = {
        profile,
        gate,
        fixture: options.fixture,
        pluginZip: options.pluginZip,
        wpEnvConfig,
        environment,
        capture: async (value, mediaType) => {
          if (typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer) {
            return evidence.put(value, { mediaType });
          }
          return evidence.putJson(value);
        },
      };
      const configurationError = missingProofConfiguration(context);
      const unverifiedResult = configurationError
        ? { status: 'blocked' as const, reason: configurationError }
        : gate === 'accessibility_manual_review'
          ? await readManualAccessibilityReview(context, evidence)
        : options.gateRunner
          ? await options.gateRunner(context)
          : await runtime.run(context);
      const result = gate === 'environment_observation' && unverifiedResult?.status === 'pass'
        ? await enforceEnvironmentObservation(unverifiedResult, environment, evidence)
        : unverifiedResult;
      records.push(await asRecord(gate, result, context, startedAt));
    }
  } finally {
    await runtime.stop();
  }

  const profileReport = evaluateProofProfile(profile, records);
  const receipt: ProofReceiptDocument = {
    schemaVersion: 1,
    kind: 'block-runner.wordpress-proof',
    createdAt: new Date().toISOString(),
    selectedProfile: profile,
    ok: profileReport.ok,
    environment,
    gates: records,
    profile: profileReport,
  };
  const receiptReference = await receiptWriter.write(receipt);
  return { ok: profileReport.ok, profile: profileReport, receipt, receiptReference };
}

/** Alias kept concise for callers that use the proof layer as a verifier. */
export const prove = runProof;

async function readManualAccessibilityReview(context: ProofGateContext, evidence: EvidenceStore): Promise<ProofGateResult> {
  const reviewPath = context.fixture?.accessibility?.manualReviewPath;
  if (!reviewPath) return { status: 'blocked', reason: 'A manual accessibility pass requires a saved review record for the exact input and ZIP.' };
  try {
    const bytes = await readFile(path.resolve(reviewPath));
    const review = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const record = await evidence.put(bytes, { mediaType: 'application/json' });
    const requiredChecks = ['editor-keyboard', 'frontend-keyboard', 'focus-visibility', 'content-reading-order'];
    const checks = review.checks as Record<string, unknown> | undefined;
    const valid = review.schemaVersion === 1 && typeof review.reviewer === 'string' && review.reviewer.trim().length > 0
      && typeof review.reviewedAt === 'string' && Number.isFinite(Date.parse(review.reviewedAt))
      && review.inputHash === context.environment.input?.sha256
      && review.pluginZipHash === context.environment.plugin.zip?.sha256
      && checks && requiredChecks.every((check) => typeof checks[check] === 'string' && String(checks[check]).trim().length > 0)
      && Array.isArray(review.findings) && ['pass', 'fail'].includes(String(review.status));
    if (!valid) return { status: 'blocked', reason: 'Manual review is incomplete or describes a different input/ZIP.', evidence: [record] };
    return { status: review.status as 'pass' | 'fail', evidence: [record], details: { review } };
  } catch (error) {
    return { status: 'blocked', reason: `Could not read manual accessibility review: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function asRecord(
  gate: ProofGateId,
  result: ProofGateResult | undefined,
  context: ProofGateContext,
  startedAt: string,
): Promise<ProofGateRecord> {
  const evidence: EvidenceReference[] = [...(result?.evidence ?? [])];
  if (result?.details) {
    evidence.push(await context.capture(result.details, 'application/json'));
  }
  return {
    gate,
    status: result?.status ?? 'blocked',
    ...(result?.reason ? { reason: result.reason } : result ? {} : { reason: 'No proof adapter ran this gate.' }),
    // Keep lifecycle observations in the receipt as well as content-addressed
    // evidence. The canonical wp_block and each core/block.content map must be
    // reviewable without inferring them from a hash alone.
    ...(result?.details ? { details: result.details } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/**
 * Do this before invoking either the bundled runner or a consumer adapter.
 * An adapter must not be able to turn omitted full-profile inputs into a green
 * receipt just by returning `pass` or `not_applicable`.
 */
function missingProofConfiguration(context: ProofGateContext): string | undefined {
  const { fixture, gate, environment } = context;
  if (!environment.input) {
    return 'Proof receipts require a pinned generator input (--input or inputPath).';
  }
  if (gate !== 'headless_validation' && !environment.plugin.zip) {
    return 'Runtime proof requires a readable, pinned plugin ZIP.';
  }
  if (['plugin_activation', 'php_registry', 'rest_block_type', 'client_registry', 'editor_inserter', 'editor_field_editing', 'editor_save', 'editor_reopen', 'static_deactivation_html', 'static_deactivation_registration', 'static_deactivation_assets', 'static_deactivation_editor_controls'].includes(gate) && !fixture?.blockName) {
    return `${gate} requires fixture.blockName.`;
  }
  if (gate === 'editor_field_editing' && (!fixture?.editableFields || fixture.editableFields.length === 0)) {
    return 'Editor proof requires a non-empty fixture.editableFields inventory.';
  }
  if (['frontend_status', 'frontend_semantics', 'frontend_links', 'frontend_media', 'frontend_assets', 'frontend_runtime_errors', 'static_deactivation_assets'].includes(gate) && !fixture?.frontend?.url) {
    return `${gate} requires fixture.frontend.url; the run will still navigate to its own published permalink.`;
  }
  if (gate === 'pattern_overrides') {
    const pattern = fixture?.patternOverrides;
    if (!fixture?.blockName || !pattern?.title || !pattern.canonicalContent || pattern.instances?.length !== 2
      || !pattern.canonicalUpdate?.content || !pattern.reset || pattern.requiredBindings.length === 0
      || !pattern.negative?.value || !pattern.negative.fallback || !pattern.structuralPolicy) {
      return 'Pattern proof requires canonical wp_block content, exactly two instances, reset/canonical-update assertions, required bindings, a structural policy, and a saved negative binding exercise.';
    }
    const canonicalCoverage = generatedBlockPatternCoverage(pattern.canonicalContent, fixture.blockName, pattern.requiredBindings);
    const updateCoverage = generatedBlockPatternCoverage(pattern.canonicalUpdate.content, fixture.blockName, pattern.requiredBindings);
    if (!canonicalCoverage.ok || !updateCoverage.ok) {
      return `Pattern proof requires every required native binding inside generated ${fixture.blockName} markup in both canonical versions.`;
    }
  }
  if (gate === 'visual_regression' && (!fixture?.visual?.expectedPath || typeof fixture.visual.threshold !== 'number')) {
    return 'Visual proof requires fixture.visual.expectedPath and threshold.';
  }
  if (['accessibility_editor', 'accessibility_frontend', 'accessibility_manual_review'].includes(gate)) {
    if (!fixture?.accessibility) return `${gate} requires fixture.accessibility scope.`;
    if (gate === 'accessibility_manual_review' && fixture.accessibility.manualReview === 'not_applicable') {
      return 'Manual accessibility review is a required full-profile assertion and cannot be not_applicable.';
    }
  }
  return undefined;
}

async function enforceEnvironmentObservation(
  result: ProofGateResult,
  environment: ProofEnvironment,
  evidenceStore: EvidenceStore,
): Promise<ProofGateResult> {
  const unobserved = await requiredRuntimeObservationFailures(environment, evidenceStore);
  const observationEvidence = environment.observations;
  const evidence = observationEvidence
    ? dedupeEvidence([...(result.evidence ?? []), observationEvidence])
    : result.evidence;
  return unobserved.length === 0
    ? { ...result, ...(evidence?.length ? { evidence } : {}) }
    : {
      status: 'blocked',
      reason: `Mandatory runtime observations were unavailable: ${unobserved.join(', ')}.`,
      details: { unobserved },
      ...(evidence?.length ? { evidence } : {}),
    };
}

function dedupeEvidence(references: readonly EvidenceReference[]): EvidenceReference[] {
  const unique = new Map<Sha256, EvidenceReference>();
  for (const reference of references) unique.set(reference.sha256, reference);
  return [...unique.values()];
}

async function collectEnvironmentPins(
  options: ProofRunOptions,
  evidence: EvidenceStore,
  wpEnvConfig: string,
): Promise<ProofEnvironment> {
  const [packagePin, lockPin, configPin, zipPin, inputPin, wordpressPackages, wpEnvPins] = await Promise.all([
    pinFile(path.join(projectRoot, 'package.json'), evidence),
    pinFile(path.join(projectRoot, 'package-lock.json'), evidence).catch(() => undefined),
    pinFile(wpEnvConfig, evidence),
    options.pluginZip ? pinFile(path.resolve(options.pluginZip), evidence).catch(() => undefined) : undefined,
    pinInput(options, evidence),
    collectWordPressPackagePins(path.join(projectRoot, 'package-lock.json')).catch(() => ({})),
    readWpEnvPins(wpEnvConfig).catch(() => ({ coreSource: 'unobserved', phpVersion: 'unobserved' })),
  ]);
  const packages = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };

  return {
    generator: {
      package: packageJson.name,
      version: packageJson.version,
      packageJson: packagePin,
      ...(lockPin ? { packageLock: lockPin } : {}),
    },
    plugin: {
      ...(zipPin ? { zip: zipPin } : {}),
      ...(options.fixture?.blockName ? { slug: pluginSlugFor(options.fixture) } : {}),
    },
    ...(inputPin ? { input: inputPin } : {}),
    wordpress: {
      requestedVersion: REQUIRED_WORDPRESS_VERSION,
      coreSource: wpEnvPins.coreSource,
      wpEnv: packages['@wordpress/env'] ?? 'unresolved',
      wpEnvConfig: configPin,
      version: 'unobserved',
      coreHash: 'unobserved',
    },
    php: { requestedVersion: wpEnvPins.phpVersion, version: 'unobserved' },
    database: { engine: 'mysql', image: 'unobserved', version: 'unobserved' },
    theme: { name: 'unobserved', version: 'unobserved', fileHash: 'unobserved' },
    browser: {
      engine: 'chromium',
      playwright: packages['@playwright/test'] ?? 'unresolved',
      revision: 'unobserved',
      version: 'unobserved',
    },
    node: { version: process.version },
    wordpressPackages,
  };
}

async function collectWordPressPackagePins(lockFile: string): Promise<Record<string, WordPressPackagePin>> {
  const parsed = JSON.parse(await readFile(lockFile, 'utf8')) as {
    packages?: Record<string, { version?: string; integrity?: string }>;
  };
  const pins: Record<string, WordPressPackagePin> = {};
  for (const [location, metadata] of Object.entries(parsed.packages ?? {})) {
    const match = /^node_modules\/(\@wordpress\/[^/]+)$/.exec(location);
    if (match && metadata.version && metadata.integrity) {
      pins[match[1]!] = { version: metadata.version, integrity: metadata.integrity };
    }
  }
  return pins;
}

async function readWpEnvPins(file: string): Promise<{ coreSource: string; phpVersion: string }> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(parsed)) return { coreSource: 'unobserved', phpVersion: 'unobserved' };
  return {
    coreSource: typeof parsed.core === 'string' ? parsed.core : 'unobserved',
    phpVersion: typeof parsed.phpVersion === 'string' ? parsed.phpVersion : 'unobserved',
  };
}

async function pinInput(options: ProofRunOptions, evidence: EvidenceStore): Promise<ProofFilePin | undefined> {
  if (options.inputPath) return pinFile(path.resolve(options.inputPath), evidence);
  if (options.input === undefined) return undefined;
  const bytes = typeof options.input === 'string' ? Buffer.from(options.input, 'utf8') : Buffer.from(options.input);
  const reference = await evidence.put(bytes, { mediaType: 'application/octet-stream' });
  return { sha256: reference.sha256, bytes: reference.bytes, evidence: reference };
}

async function pinFile(file: string, evidence: EvidenceStore): Promise<ProofFilePin> {
  const bytes = await readFile(file);
  const reference = await evidence.put(bytes, { mediaType: mediaTypeFor(file) });
  return { path: file, sha256: reference.sha256, bytes: reference.bytes, evidence: reference };
}

function mediaTypeFor(file: string): string {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.zip')) return 'application/zip';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function createRuntime(
  options: ProofRunOptions,
  environment: ProofEnvironment,
  wpEnvConfig: string,
  evidence: EvidenceStore,
): { run: (context: ProofGateContext) => Promise<ProofGateResult>; stop: () => Promise<void> } {
  let environmentStarted = false;
  let staticPluginDeactivated = false;
  let deactivationEvidence: EvidenceReference | undefined;
  let browserResults: Partial<Record<ProofGateId, ProofGateResult>> | undefined;
  let deactivatedBrowserResults: Partial<Record<ProofGateId, ProofGateResult>> | undefined;
  let stagedPluginZip: { host: string; container: string } | undefined;
  let publication: ProofPublication | undefined;
  let preparedPattern: PreparedSyncedPattern | undefined;
  let startupFailure: ProofGateResult | undefined;
  const command = options.commandRunner ?? runCommand;

  const wpEnv = async (args: string[], phase = `wp-env:${args.slice(0, 3).join(' ')}`): Promise<ProofCommandResult> => {
    const result = await command('npx', ['--no-install', 'wp-env', `--config=${wpEnvConfig}`, ...args], {
      cwd: projectRoot,
      timeoutMs: args[0] === 'start' ? PROOF_COMMAND_TIMEOUTS.wpEnvStart : PROOF_COMMAND_TIMEOUTS.wpEnv,
      phase,
    });
    return result;
  };
  const logged = async (result: ProofCommandResult): Promise<EvidenceReference> =>
    evidence.putJson(result);
  const start = async (): Promise<ProofGateResult> => {
    if (options.execute === false) return { status: 'blocked', reason: 'Proof execution was disabled.' };
    if (environmentStarted) return { status: 'pass', reason: 'Pinned wp-env is already running.' };
    if (startupFailure) return startupFailure;
    if (!options.pluginZip) return { status: 'blocked', reason: 'Runtime proof requires --plugin-zip.' };
    const docker = await command('docker', ['info', '--format', '{{.ServerVersion}}'], {
      cwd: projectRoot,
      timeoutMs: PROOF_COMMAND_TIMEOUTS.docker,
      phase: 'docker-info',
    });
    const dockerLog = await logged(docker);
    if (docker.exitCode !== 0) {
      startupFailure = {
        status: 'blocked',
        reason: 'A working Docker CLI and daemon are required for the WordPress 7.1 proof.',
        evidence: [dockerLog],
      };
      return startupFailure;
    }
    const staged = await stagePluginZip();
    if (staged.status !== 'pass') {
      startupFailure = staged;
      return startupFailure;
    }
    const result = await wpEnv(['start'], 'wp-env-start');
    const log = await logged(result);
    if (result.exitCode !== 0) {
      startupFailure = { status: 'blocked', reason: 'wp-env could not start Docker/MySQL.', evidence: [dockerLog, log] };
      return startupFailure;
    }
    environmentStarted = true;
    await collectObservedRuntimePins(wpEnv, command, environment, evidence);
    return { status: 'pass', evidence: [dockerLog, log] };
  };
  const wp = async (php: string): Promise<{ result: ProofCommandResult; evidence: EvidenceReference }> => {
    const result = await wpEnv(['run', 'cli', 'wp', 'eval', php]);
    return { result, evidence: await logged(result) };
  };
  const stagePluginZip = async (): Promise<ProofGateResult> => {
    if (stagedPluginZip) return { status: 'pass', details: { stagedPluginZip: stagedPluginZip.container } };
    if (!options.pluginZip || !environment.plugin.zip) {
      return { status: 'blocked', reason: 'A readable plugin ZIP is required before it can be staged in wp-env.' };
    }
    // `wp-env run cli` receives a container path, never a host path. The
    // bundled config mounts this directory at stagedZipContainerDirectory.
    const basename = `block-runner-proof-${environment.plugin.zip.sha256.slice('sha256:'.length)}.zip`;
    const host = path.join(stagedZipDirectory, basename);
    try {
      await mkdir(stagedZipDirectory, { recursive: true });
      await copyFile(path.resolve(options.pluginZip), host);
    } catch (error) {
      return { status: 'blocked', reason: `Could not stage the plugin ZIP in the wp-env mount: ${error instanceof Error ? error.message : String(error)}` };
    }
    stagedPluginZip = { host, container: `${stagedZipContainerDirectory}/${basename}` };
    return { status: 'pass', details: { stagedPluginZip: stagedPluginZip.container } };
  };
  const browser = async (mode: 'active' | 'deactivated' = 'active'): Promise<Partial<Record<ProofGateId, ProofGateResult>>> => {
    const cached = mode === 'active' ? browserResults : deactivatedBrowserResults;
    if (cached) return cached;
    if (!environmentStarted) return {};
    if (!options.fixture) return {};
    try {
      await access(playwrightHelper, fsConstants.R_OK);
    } catch {
      return {};
    }
    const workRoot = path.resolve(options.outputDir ?? 'proof-receipts');
    await mkdir(workRoot, { recursive: true });
    const work = await mkdtemp(path.join(workRoot, 'browser-'));
    const config = path.join(work, 'proof.json');
    const report = path.join(work, 'result.json');
    try {
      if (mode === 'active' && options.profile === 'full' && options.fixture.patternOverrides) {
        const prepared = await prepareSyncedPattern();
        if (!prepared) {
          browserResults = Object.fromEntries(browserGateIds.map((gate) => [gate, {
              status: 'blocked',
              reason: 'Could not create and read the canonical synced wp_block fixture.',
            }])) as Partial<Record<ProofGateId, ProofGateResult>>;
          return browserResults;
        }
      }
      const fixture = preparedPattern
        ? {
            ...options.fixture,
            patternOverrides: {
              ...options.fixture.patternOverrides!,
              ref: preparedPattern.ref,
              storedCanonicalContent: preparedPattern.canonicalContent,
              instances: preparedPattern.instances,
              negative: {
                ...options.fixture.patternOverrides!.negative,
                ...preparedPattern.negative,
              },
            },
            frontend: options.fixture.frontend
              ? {
                  ...options.fixture.frontend,
                  expectedMedia: expectedPatternMedia(preparedPattern.instances),
                }
              : undefined,
          }
        : options.fixture;
      await writeFile(config, JSON.stringify({ fixture, profile: options.profile, baseUrl: 'http://localhost:8888', mode, publication }), 'utf8');
      const result = await command(process.execPath, [playwrightHelper, '--config', config, '--out', report], {
        cwd: projectRoot,
        timeoutMs: PROOF_COMMAND_TIMEOUTS.browser,
        phase: `browser-${mode}`,
      });
      const logs = await logged(result);
      if (result.exitCode !== 0) {
        const failedResults = Object.fromEntries(
          browserGateIds.map((gate) => [gate, { status: 'blocked', reason: 'Playwright browser proof did not complete.', evidence: [logs] }]),
        ) as Partial<Record<ProofGateId, ProofGateResult>>;
        if (mode === 'active') browserResults = failedResults;
        else deactivatedBrowserResults = failedResults;
        return failedResults;
      }
      const raw = JSON.parse(await readFile(report, 'utf8')) as {
        gates?: Record<string, ProofGateResult & { artifacts?: Array<{ path: string; mediaType: string }> }>;
        environment?: { browser?: { version?: string; revision?: string } };
        publication?: unknown;
        phases?: unknown;
      };
      if (raw.environment?.browser?.version) environment.browser.version = raw.environment.browser.version;
      if (raw.environment?.browser?.revision) environment.browser.revision = raw.environment.browser.revision;
      if (raw.publication && isProofPublication(raw.publication)) publication = raw.publication;
      const phaseEvidence = raw.phases === undefined ? undefined : await evidence.putJson({ mode, phases: raw.phases });
      const completedResults = Object.fromEntries(
        (await Promise.all(Object.entries(raw.gates ?? {}).map(async ([gate, value]) => {
          if (!isGateId(gate)) return [];
          const artifacts = await Promise.all((value.artifacts ?? []).map(async (artifact) => {
            const absolute = path.resolve(work, artifact.path);
            if (!absolute.startsWith(`${work}${path.sep}`)) {
              throw new Error(`Playwright helper returned an artifact outside its work directory: ${artifact.path}`);
            }
            return evidence.put(await readFile(absolute), { mediaType: artifact.mediaType });
          }));
          return [[gate, {
            ...value,
            evidence: [...(value.evidence ?? []), ...artifacts, logs, ...(phaseEvidence ? [phaseEvidence] : [])],
          }]];
        }))).flat(),
      ) as Partial<Record<ProofGateId, ProofGateResult>>;
      if (mode === 'active') browserResults = completedResults;
      else deactivatedBrowserResults = completedResults;
      return completedResults;
    } catch (error) {
      const failedResults = Object.fromEntries(
        browserGateIds.map((gate) => [gate, { status: 'blocked', reason: error instanceof Error ? error.message : String(error) }]),
      ) as Partial<Record<ProofGateId, ProofGateResult>>;
      if (mode === 'active') browserResults = failedResults;
      else deactivatedBrowserResults = failedResults;
      return failedResults;
    }
  };

  /**
   * A synced pattern is a first-class wp_block post. Create it before the
   * browser run rather than smuggling a site-specific reference into fixtures;
   * the observed ref and exact stored canonical content travel in evidence.
   */
  const prepareSyncedPattern = async (): Promise<PreparedSyncedPattern | undefined> => {
    if (preparedPattern) return preparedPattern;
    const pattern = options.fixture?.patternOverrides;
    if (!pattern) return undefined;
    const media = await preparePatternMedia(pattern.instances);
    if (!media) return undefined;
    const instances = applyPreparedPatternMedia(pattern.instances, media);
    const positive = await saveSyncedPattern(pattern.title, pattern.canonicalContent);
    const negativeTitle = `${pattern.title} — missing ${pattern.negative.name}.${pattern.negative.attribute}`;
    const negativeContent = removeRequiredPatternBinding(pattern.canonicalContent, pattern.negative);
    const negative = await saveSyncedPattern(negativeTitle, negativeContent);
    if (!positive || !negative) return undefined;
    preparedPattern = {
      ref: positive.ref,
      canonicalContent: positive.canonicalContent,
      instances,
      negative: {
        ref: negative.ref,
        title: negativeTitle,
        canonicalContent: negative.canonicalContent,
      },
    };
    return preparedPattern;
  };

  /** Save both the positive and deliberately deficient patterns through WordPress. */
  const saveSyncedPattern = async (
    title: string,
    content: string,
  ): Promise<{ ref: number; canonicalContent: string } | undefined> => {
    const title64 = Buffer.from(title, 'utf8').toString('base64');
    const content64 = Buffer.from(content, 'utf8').toString('base64');
    const php = [
      "$title = base64_decode('" + title64 + "');",
      "$content = base64_decode('" + content64 + "');",
      "$matches = get_posts(array('post_type' => 'wp_block', 'post_status' => 'any', 'title' => $title, 'numberposts' => 1));",
      "$id = $matches ? $matches[0]->ID : 0;",
      "$saved = wp_insert_post(array('ID' => $id, 'post_type' => 'wp_block', 'post_status' => 'publish', 'post_title' => $title, 'post_content' => $content), true);",
      "if (is_wp_error($saved)) { echo json_encode(array('error' => $saved->get_error_message())); } else { update_post_meta($saved, 'wp_pattern_sync_status', 'sync'); echo json_encode(array('id' => (int) $saved, 'content' => get_post_field('post_content', $saved))); }",
    ].join(' ');
    const { result } = await wp(php);
    if (result.exitCode !== 0) return undefined;
    try {
      const observed = JSON.parse(result.stdout.trim()) as { id?: unknown; content?: unknown };
      return Number.isInteger(observed.id) && Number(observed.id) > 0 && typeof observed.content === 'string'
        ? { ref: Number(observed.id), canonicalContent: observed.content }
        : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * The media modal can only prove a selection with real library records. Make
   * two tiny, local attachments and replace fixture image ids/URLs with the
   * observations WordPress will expose to the native image control.
   */
  const preparePatternMedia = async (
    instances: readonly ProofPatternInstance[],
  ): Promise<readonly { id: number; url: string }[] | undefined> => {
    const php = [
      "require_once ABSPATH . 'wp-admin/includes/image.php';",
      `$png = base64_decode('${PROOF_IMAGE_BASE64}');`,
      '$result = array();',
      `for ($index = 0; $index < ${instances.length}; $index++) {`,
      "  $filename = 'block-runner-proof-pattern-' . $index . '.png';",
      '  $upload = wp_upload_bits($filename, null, $png);',
      "  if (!empty($upload['error'])) { throw new RuntimeException('Proof media upload failed: ' . $upload['error']); }",
      "  $file = $upload['file'];",
      "  if (!is_readable($file) || hash_file('sha256', $file) !== hash('sha256', $png)) { throw new RuntimeException('Proof media bytes were not retained correctly.'); }",
      "  $attachment = array('post_mime_type' => 'image/png', 'post_title' => 'Block Runner proof pattern ' . ($index + 1), 'post_status' => 'inherit');",
      '  $id = wp_insert_attachment($attachment, $file, 0, true);',
      "  if (is_wp_error($id) || !$id) { throw new RuntimeException('Proof media attachment registration failed.'); }",
      '  $metadata = wp_generate_attachment_metadata($id, $file);',
      '  wp_update_attachment_metadata($id, $metadata);',
      "  $result[] = array('id' => (int) $id, 'url' => wp_get_attachment_url($id));",
      '}',
      'echo json_encode($result);',
    ].join(' ');
    const { result } = await wp(php);
    if (result.exitCode !== 0) return undefined;
    try {
      const media = JSON.parse(result.stdout.trim()) as Array<{ id?: unknown; url?: unknown }>;
      if (!Array.isArray(media) || media.length !== instances.length) return undefined;
      const normalized = media.map((item) => ({ id: Number(item.id), url: typeof item.url === 'string' ? item.url : '' }));
      return normalized.every((item) => Number.isInteger(item.id) && item.id > 0 && item.url) ? normalized : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async run(context) {
      if (context.gate === 'headless_validation') {
        if (options.pluginZip && !environment.plugin.zip) {
          return { status: 'blocked', reason: `Could not capture the built plugin ZIP: ${options.pluginZip}` };
        }
        if (!options.markup) return { status: 'blocked', reason: 'Headless proof requires markup from the generated block fixture.' };
        const report = await validate(options.markup);
        return {
          status: report.ok ? 'pass' : 'fail',
          reason: report.ok ? undefined : 'Headless Gutenberg rejected the generated markup.',
          details: report as unknown as Record<string, unknown>,
        };
      }

      const started = await start();
      if (started.status !== 'pass') return started;

      if (context.gate === 'zip_installation') {
        const staged = await stagePluginZip();
        if (staged.status !== 'pass') return staged;
        const result = await wpEnv(['run', 'cli', 'wp', 'plugin', 'install', stagedPluginZip!.container, '--force', '--activate']);
        const log = await logged(result);
        if (result.exitCode !== 0) {
          return { status: 'fail', reason: 'WordPress could not install the built ZIP.', evidence: [...(staged.evidence ?? []), log] };
        }
        const metadata = await observePluginMetadata(wpEnv, context.fixture, environment, evidence);
        return metadata.status === 'pass'
          ? { status: 'pass', evidence: [...(staged.evidence ?? []), log, ...(metadata.evidence ?? [])], details: metadata.details }
          : { status: metadata.status, reason: metadata.reason, evidence: [...(staged.evidence ?? []), log, ...(metadata.evidence ?? [])], details: metadata.details };
      }
      if (context.gate === 'plugin_activation') {
        if (!context.fixture?.blockName) return { status: 'blocked', reason: 'Plugin activation needs fixture.blockName to resolve its slug.' };
        const plugin = pluginSlugFor(context.fixture);
        const result = await wpEnv(['run', 'cli', 'wp', 'plugin', 'is-active', plugin]);
        const log = await logged(result);
        return result.exitCode === 0
          ? { status: 'pass', evidence: [log] }
          : { status: 'fail', reason: 'Built plugin is not active after installation.', evidence: [log] };
      }
      if (context.gate === 'php_registry') {
        if (!context.fixture?.blockName) return { status: 'blocked', reason: 'PHP registry proof needs fixture.blockName.' };
        const { result, evidence: log } = await wp(`echo WP_Block_Type_Registry::get_instance()->is_registered(${phpString(context.fixture.blockName)}) ? 'registered' : 'missing';`);
        return result.exitCode === 0 && result.stdout.trim() === 'registered'
          ? { status: 'pass', evidence: [log] }
          : { status: 'fail', reason: 'PHP block registry did not contain the generated block.', evidence: [log] };
      }
      if (context.gate === 'rest_block_type') {
        if (!context.fixture?.blockName) return { status: 'blocked', reason: 'REST registry proof needs fixture.blockName.' };
        const { result, evidence: log } = await wp(
          `wp_set_current_user(1); $request = new WP_REST_Request('GET', ${phpString(blockTypeRoute(context.fixture.blockName))}); $response = rest_do_request($request); echo $response->get_status();`,
        );
        return result.exitCode === 0 && result.stdout.trim() === '200'
          ? { status: 'pass', evidence: [log] }
          : { status: 'fail', reason: 'REST block-type endpoint did not expose the generated block.', evidence: [log] };
      }

      if (context.gate === 'php_logs') {
        const result = await wpEnv(['logs', '--no-watch']);
        const log = await logged(result);
        const fatal = findPhpFatal(`${result.stdout}\n${result.stderr}`);
        return result.exitCode === 0 && fatal.length === 0
          ? { status: 'pass', evidence: [log], details: { phpLog: result.stdout } }
          : { status: 'fail', reason: fatal.length > 0 ? 'PHP/Docker logs contained fatal errors.' : 'Could not collect PHP/Docker logs.', evidence: [log], details: { phpLog: result.stdout, fatal } };
      }

      if (browserGateIds.includes(context.gate)) {
        const results = await browser();
        return results[context.gate] ?? { status: 'blocked', reason: 'No browser result was recorded for this gate.' };
      }

      if (context.gate === 'environment_observation') {
        const unobserved = await requiredRuntimeObservationFailures(environment, evidence);
        return unobserved.length === 0
          ? {
            status: 'pass',
            details: { observed: true },
            ...(environment.observations ? { evidence: [environment.observations] } : {}),
          }
          : {
            status: 'blocked',
            reason: `Mandatory runtime observations were unavailable: ${unobserved.join(', ')}.`,
            details: { unobserved },
            ...(environment.observations ? { evidence: [environment.observations] } : {}),
          };
      }

      // Deactivation is intentionally after the frontend/browser snapshot. The checks distinguish
      // saved HTML from code-owned registrations, styles/scripts, and editor controls.
      if (context.gate.startsWith('static_deactivation_')) {
        if (!context.fixture?.blockName) return { status: 'blocked', reason: 'Static deactivation proof needs fixture.blockName.' };
        if (!staticPluginDeactivated) {
          const result = await wpEnv(['run', 'cli', 'wp', 'plugin', 'deactivate', pluginSlugFor(context.fixture)]);
          const log = await logged(result);
          if (result.exitCode !== 0) return { status: 'fail', reason: 'Could not deactivate the static plugin.', evidence: [log] };
          staticPluginDeactivated = true;
          deactivationEvidence = log;
        }
        if (context.gate === 'static_deactivation_html') {
          if (!publication) return { status: 'blocked', reason: 'Browser proof did not record the post it published.', ...(deactivationEvidence ? { evidence: [deactivationEvidence] } : {}) };
          const { result, evidence: log } = await wp(`$post = get_post(${publication.id}); echo $post ? base64_encode($post->post_content) : '';`);
          const after = result.exitCode === 0 && result.stdout.trim()
            ? Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
            : undefined;
          const identical = after === publication.savedContent;
          return result.exitCode === 0 && after !== undefined && identical
            ? { status: 'pass', evidence: [log], details: { postId: publication.id, permalink: publication.permalink, beforeHtml: publication.savedContent, afterHtml: after, beforeHash: sha256Text(publication.savedContent), afterHash: sha256Text(after), identical } }
            : { status: 'fail', reason: 'Published block HTML changed or could not be read after deactivation.', evidence: [log], details: { postId: publication.id, permalink: publication.permalink, beforeHtml: publication.savedContent, beforeHash: sha256Text(publication.savedContent), ...(after === undefined ? {} : { afterHtml: after, afterHash: sha256Text(after), identical }) } };
        }
        if (context.gate === 'static_deactivation_registration') {
          const name = context.fixture.blockName;
          const { result, evidence: log } = await wp(
            `wp_set_current_user(1); $name = ${phpString(name)}; $php = WP_Block_Type_Registry::get_instance()->is_registered($name); $request = new WP_REST_Request('GET', ${phpString(blockTypeRoute(name))}); $rest = rest_do_request($request)->get_status(); echo json_encode(array('phpRegistered' => $php, 'restStatus' => $rest));`,
          );
          let observed: { phpRegistered?: boolean; restStatus?: number } | undefined;
          try { observed = JSON.parse(result.stdout.trim()) as { phpRegistered?: boolean; restStatus?: number }; } catch { /* evidence holds malformed output */ }
          return result.exitCode === 0 && observed?.phpRegistered === false && observed.restStatus === 404
            ? { status: 'pass', evidence: [log], details: observed }
            : { status: 'fail', reason: 'Plugin-owned PHP/REST registrations survived deactivation.', evidence: [log], ...(observed ? { details: observed } : {}) };
        }
        const deactivated = await browser('deactivated');
        const mapped = context.gate === 'static_deactivation_assets'
          ? deactivated.static_deactivation_assets
          : deactivated.static_deactivation_editor_controls;
        if (mapped) return mapped;
        return {
          status: 'blocked',
          reason: 'Deactivation completed, but this gate needs a browser/PHP deactivation adapter to inspect its distinct claim.',
          ...(deactivationEvidence ? { evidence: [deactivationEvidence] } : {}),
        };
      }
      return { status: 'blocked', reason: `No built-in runner is available for ${context.gate}.` };
    },
    async stop() {
      if (environmentStarted && !options.keepEnvironment) await wpEnv(['stop']).catch(() => undefined);
      // Keep the staged ZIP and browser work alongside the receipt until the
      // caller explicitly cleans its proof artifacts. Failed runs need these too.
    },
  };
}

const browserGateIds: readonly ProofGateId[] = [
  'client_registry',
  'editor_inserter',
  'editor_field_editing',
  'editor_save',
  'editor_reopen',
  'frontend_status',
  'frontend_semantics',
  'frontend_links',
  'frontend_media',
  'frontend_assets',
  'frontend_runtime_errors',
  'php_logs',
  'pattern_overrides',
  'visual_regression',
  'accessibility_editor',
  'accessibility_frontend',
  'accessibility_manual_review',
];

function applyPreparedPatternMedia(
  instances: readonly ProofPatternInstance[],
  media: readonly { id: number; url: string }[],
): readonly ProofPatternInstance[] {
  return instances.map((instance, index) => {
    const selection = media[index];
    if (!selection) return instance;
    return {
      ...instance,
      content: Object.fromEntries(
        Object.entries(instance.content).map(([name, attributes]) => [
          name,
          'id' in attributes && 'url' in attributes
            ? { ...attributes, id: selection.id, url: selection.url }
            : attributes,
        ]),
      ),
    };
  });
}

function expectedPatternMedia(instances: readonly ProofPatternInstance[]): string[] {
  return instances.flatMap((instance) => Object.values(instance.content)
    .flatMap((attributes) => Number.isInteger(attributes.id) && typeof attributes.url === 'string' ? [attributes.url] : []));
}

/** Remove one binding only to construct a negative wp_block that WordPress saves and renders. */
function removeRequiredPatternBinding(content: string, requirement: ProofPatternRequiredBinding): string {
  return content.replace(/<!-- wp:([^\s]+)(?:\s+({[\s\S]*?}))?\s*-->/g, (comment, name: string, rawAttributes?: string) => {
    if (!rawAttributes) return comment;
    try {
      const attributes = JSON.parse(rawAttributes) as {
        metadata?: { name?: unknown; bindings?: Record<string, unknown> };
      };
      if (attributes.metadata?.name !== requirement.name || !attributes.metadata.bindings) return comment;
      delete attributes.metadata.bindings.__default;
      delete attributes.metadata.bindings[requirement.attribute];
      return `<!-- wp:${name} ${JSON.stringify(attributes)} -->`;
    } catch {
      return comment;
    }
  });
}

/**
 * A Core-only wp_block cannot prove generated-block support. Every required
 * binding must be nested inside the actual custom wrapper in both canonical
 * versions before a runner or external adapter may report a passing gate.
 */
function generatedBlockPatternCoverage(
  content: string,
  blockName: string,
  requirements: readonly ProofPatternRequiredBinding[],
): { ok: boolean; blockName: string; missing: ProofPatternRequiredBinding[]; reason?: string } {
  const opening = `<!-- wp:${blockName}`;
  const closing = `<!-- /wp:${blockName} -->`;
  const start = content.indexOf(opening);
  const openingEnd = start === -1 ? -1 : content.indexOf('-->', start);
  const end = openingEnd === -1 ? -1 : content.indexOf(closing, openingEnd + 3);
  if (start === -1 || openingEnd === -1 || end === -1) {
    return { ok: false, blockName, missing: [...requirements], reason: 'generated_block_absent' };
  }
  const enclosed = content.slice(openingEnd + 3, end);
  type PatternCommentAttributes = {
    metadata?: { name?: unknown; bindings?: Record<string, { source?: unknown }> };
  };
  const blocks: PatternCommentAttributes[] = [...enclosed.matchAll(/<!-- wp:([^\s]+)(?:\s+({[\s\S]*?}))?\s*-->/g)].flatMap((match) => {
    try {
      const attributes: PatternCommentAttributes = match[2]
        ? JSON.parse(match[2]) as PatternCommentAttributes
        : {};
      return [attributes];
    } catch {
      return [];
    }
  });
  const missing = requirements.filter((requirement) => !blocks.some((attributes) =>
    attributes.metadata?.name === requirement.name
      && (attributes.metadata.bindings?.__default?.source === 'core/pattern-overrides'
        || attributes.metadata.bindings?.[requirement.attribute]?.source === 'core/pattern-overrides')));
  return { ok: missing.length === 0, blockName, missing };
}
function isGateId(value: string): value is ProofGateId {
  return (PROOF_GATE_IDS as readonly string[]).includes(value);
}

function pluginSlug(blockName: string): string {
  return blockName.includes('/') ? blockName.slice(blockName.indexOf('/') + 1) : blockName;
}

function pluginSlugFor(fixture: ProofFixture): string {
  return fixture.pluginSlug ?? pluginSlug(fixture.blockName);
}

function phpString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function blockTypeRoute(blockName: string): string {
  const [namespace, name, ...rest] = blockName.split('/');
  if (!namespace || !name || rest.length > 0) {
    throw new TypeError(`A block type REST route requires namespace/name, received ${JSON.stringify(blockName)}.`);
  }
  // WP_REST_Request matches route segments; `%2F` is not decoded into the
  // controller's namespace/name parameters when a request is constructed here.
  return `/wp/v2/block-types/${namespace}/${name}`;
}

function sha256Text(value: string): Sha256 {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function findPhpFatal(log: string): string[] {
  const matcher = /(?:PHP\s+)?(?:Fatal error|Parse error|Uncaught (?:Error|Exception)|Allowed memory size(?: of)?|Call to undefined (?:function|method|class))/gi;
  return [...log.matchAll(matcher)].map((match) => match[0]);
}

function isProofPublication(value: unknown): value is ProofPublication {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProofPublication>;
  return Number.isInteger(candidate.id) && (candidate.id ?? 0) > 0
    && typeof candidate.permalink === 'string' && candidate.permalink.length > 0
    && typeof candidate.savedContent === 'string';
}

async function observePluginMetadata(
  wpEnv: (args: string[]) => Promise<ProofCommandResult>,
  fixture: ProofFixture | undefined,
  environment: ProofEnvironment,
  evidence: EvidenceStore,
): Promise<ProofGateResult> {
  if (!fixture?.blockName) return { status: 'blocked', reason: 'Plugin metadata observation requires fixture.blockName.' };
  const slug = pluginSlugFor(fixture);
  // `wp plugin get` returns title/version, but not the bootstrap file. Read
  // WordPress's actual plugin registry instead of inventing a slug.php path.
  const result = await wpEnv(['run', 'cli', 'wp', 'eval', [
    "require_once ABSPATH . 'wp-admin/includes/plugin.php';",
    '$matches = array();',
    `foreach ( get_plugins() as $file => $data ) { if ( dirname($file) === ${phpString(slug)} ) { $matches[] = array('name' => $data['Name'], 'version' => $data['Version'], 'plugin' => $file); } }`,
    "echo json_encode(count($matches) === 1 ? $matches[0] : array('error' => 'ambiguous or missing plugin bootstrap'));",
  ].join(' ')]);
  const log = await evidence.putJson(result);
  let metadata: { name?: unknown; version?: unknown; plugin?: unknown } | undefined;
  try {
    metadata = JSON.parse(result.stdout) as { name?: unknown; version?: unknown; plugin?: unknown };
  } catch {
    // The command evidence has the unparsable response.
  }
  const name = typeof metadata?.name === 'string' ? metadata.name : '';
  const version = typeof metadata?.version === 'string' ? metadata.version : '';
  const file = typeof metadata?.plugin === 'string' ? metadata.plugin : '';
  if (result.exitCode !== 0 || !name || !version || !file) {
    return { status: 'blocked', reason: 'WordPress did not expose complete metadata for the installed plugin ZIP.', evidence: [log], details: { slug, metadata: metadata ?? null } };
  }
  environment.plugin.slug = slug;
  environment.plugin.name = name;
  environment.plugin.version = version;
  environment.plugin.file = file;
  return { status: 'pass', evidence: [log], details: { slug, name, version, file } };
}

async function requiredRuntimeObservationFailures(
  environment: ProofEnvironment,
  evidenceStore: EvidenceStore,
): Promise<string[]> {
  const failures: string[] = [];
  const missing = (value: string | undefined): boolean => !value || value === 'unobserved' || value === 'unresolved';
  const requirePin = async (name: string, pin: ProofFilePin | undefined): Promise<void> => {
    if (!isPinnedFile(pin)) {
      failures.push(name);
      return;
    }
    try {
      const bytes = await evidenceStore.read(pin.evidence);
      if (bytes.byteLength !== pin.bytes || hashBytes(bytes) !== pin.sha256) failures.push(name);
    } catch {
      failures.push(name);
    }
  };

  await Promise.all([
    requirePin('generator.packageJson', environment.generator.packageJson),
    requirePin('generator.packageLock', environment.generator.packageLock),
    requirePin('wordpress.wpEnvConfig', environment.wordpress.wpEnvConfig),
    requirePin('input', environment.input),
    requirePin('plugin.zip', environment.plugin.zip),
  ]);
  if (missing(environment.generator.package)) failures.push('generator.package');
  if (!isReleaseVersion(environment.generator.version)) failures.push('generator.version');
  if (environment.wordpress.requestedVersion !== REQUIRED_WORDPRESS_VERSION) failures.push('wordpress.requestedVersion');
  if (environment.wordpress.coreSource !== REQUIRED_WORDPRESS_CORE_SOURCE) failures.push('wordpress.coreSource');
  if (environment.php.requestedVersion !== REQUIRED_PHP_SERIES) failures.push('php.requestedVersion');
  if (!['mysql', 'mariadb'].includes(environment.database.engine)) failures.push('database.engine');
  if (environment.browser.engine !== 'chromium') failures.push('browser.engine');
  if (!isExactSemver(environment.wordpress.wpEnv)) failures.push('wordpress.wpEnv');
  if (!isExactSemver(environment.browser.playwright)) failures.push('browser.playwright');
  if (!/^v\d+\.\d+\.\d+$/.test(environment.node.version)) failures.push('node.version');

  if (missing(environment.plugin.slug)) failures.push('plugin.slug');
  if (missing(environment.plugin.name)) failures.push('plugin.name');
  if (!isReleaseVersion(environment.plugin.version)) failures.push('plugin.version');
  if (missing(environment.plugin.file)) failures.push('plugin.file');
  if (!isExactWordPressVersion(environment.wordpress.version)) failures.push('wordpress.version');
  if (!isSha256Address(environment.wordpress.coreHash)) failures.push('wordpress.coreHash');
  if (!isSha256Address(environment.wordpress.dockerImage)) failures.push('wordpress.dockerImage');
  if (!isRequiredPhpVersion(environment.php.version)) failures.push('php.version');
  if (!isSha256Address(environment.database.image)) failures.push('database.image');
  if (!isDatabaseVersion(environment.database.version)) failures.push('database.version');
  if (!isThemeName(environment.theme.name)) failures.push('theme.name');
  if (!isReleaseVersion(environment.theme.version)) failures.push('theme.version');
  if (!isSha256Address(environment.theme.fileHash)) failures.push('theme.fileHash');
  if (!isBrowserVersion(environment.browser.version)) failures.push('browser.version');
  if (!/^\d+$/.test(environment.browser.revision)) failures.push('browser.revision');
  failures.push(...requiredWordPressPackageFailures(environment));

  const observation = await readRuntimeObservations(environment.observations, evidenceStore);
  if ('failures' in observation) {
    failures.push(...observation.failures);
  } else {
    const observed = observation.values;
    if (environment.php.version !== observed.php.version) failures.push('observations.php.value');
    if (environment.database.version !== observed.database.version) failures.push('observations.database.value');
    if (environment.database.engine !== observed.database.engine) failures.push('observations.database.engine');
    if (environment.database.image !== observed.database.image) failures.push('observations.databaseImage.value');
    if (environment.theme.name !== observed.theme.name || environment.theme.version !== observed.theme.version) failures.push('observations.theme.value');
    if (environment.theme.fileHash !== observed.theme.fileHash) failures.push('observations.themeHash.value');
    if (environment.wordpress.version !== observed.wordpress.version) failures.push('observations.wordpress.value');
    if (environment.wordpress.coreHash !== observed.wordpress.coreHash) failures.push('observations.coreHash.value');
    if (environment.wordpress.dockerImage !== observed.wordpress.dockerImage) failures.push('observations.wordpressImage.value');
  }

  return [...new Set(failures)];
}

function requiredWordPressPackageFailures(environment: ProofEnvironment): string[] {
  const packages = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
  return Object.entries(packages)
    .filter(([name]) => name.startsWith('@wordpress/'))
    .flatMap(([name, requestedVersion]) => {
      const observed = environment.wordpressPackages[name];
      return observed
        && observed.version === requestedVersion
        && isNpmIntegrity(observed.integrity)
        ? []
        : [`wordpressPackages.${name}`];
    });
}

type RuntimeObservationMap = Record<(typeof RUNTIME_OBSERVATION_COMMANDS)[number], ProofCommandResult>;

type ObservedRuntimeValues = {
  php: { version: string };
  database: { engine: 'mysql' | 'mariadb'; version: string; image: string };
  theme: { name: string; version: string; fileHash: string };
  wordpress: { version: string; coreHash: string; dockerImage: string };
};

async function readRuntimeObservations(
  reference: EvidenceReference | undefined,
  evidenceStore: EvidenceStore,
): Promise<{ values: ObservedRuntimeValues } | { failures: string[] }> {
  if (!isEvidenceReference(reference)) return { failures: ['environment.observations'] };

  let raw: unknown;
  try {
    raw = JSON.parse((await evidenceStore.read(reference)).toString('utf8'));
  } catch {
    return { failures: ['environment.observations'] };
  }
  if (!isRuntimeObservationMap(raw)) return { failures: ['environment.observations'] };

  const failedCommands = RUNTIME_OBSERVATION_COMMANDS
    .filter((name) => raw[name].exitCode !== 0)
    .map((name) => `observations.${name}.exitCode`);
  if (failedCommands.length > 0) return { failures: failedCommands };

  const php = parsePhpVersion(firstLine(raw.php.stdout));
  const databaseVersion = parseDatabaseVersion(firstLine(raw.database.stdout));
  const theme = parseActiveTheme(raw.theme.stdout);
  const themeHash = parseSha256(firstLine(raw.themeHash.stdout));
  const wordpressVersion = parseWordPressVersion(firstLine(raw.wordpress.stdout));
  const coreHash = parseSha256(firstLine(raw.coreHash.stdout));
  const wordpressContainerId = containerIdFromOutput(raw.wordpressContainer.stdout);
  const databaseContainerId = containerIdFromOutput(raw.databaseContainer.stdout);
  const wordpressImage = parseContainerImage(raw.wordpressImage.stdout, wordpressContainerId);
  const databaseImage = parseContainerImage(raw.databaseImage.stdout, databaseContainerId);
  const failures = [
    !php && 'observations.php.value',
    !databaseVersion && 'observations.database.value',
    !theme && 'observations.theme.value',
    !themeHash && 'observations.themeHash.value',
    !wordpressVersion && 'observations.wordpress.value',
    !coreHash && 'observations.coreHash.value',
    !wordpressContainerId && 'observations.wordpressContainer.value',
    !databaseContainerId && 'observations.databaseContainer.value',
    !wordpressImage && 'observations.wordpressImage.value',
    !databaseImage && 'observations.databaseImage.value',
  ].filter((value): value is string => Boolean(value));
  if (failures.length > 0 || !php || !databaseVersion || !theme || !themeHash || !wordpressVersion || !coreHash || !wordpressContainerId || !databaseContainerId || !wordpressImage || !databaseImage) {
    return { failures };
  }

  return {
    values: {
      php: { version: php },
      database: { engine: /mariadb/i.test(databaseVersion) ? 'mariadb' : 'mysql', version: databaseVersion, image: databaseImage },
      theme: { ...theme, fileHash: themeHash },
      wordpress: { version: wordpressVersion, coreHash, dockerImage: wordpressImage },
    },
  };
}

async function collectObservedRuntimePins(
  wpEnv: (args: string[]) => Promise<ProofCommandResult>,
  command: ProofCommandRunner,
  environment: ProofEnvironment,
  evidence: EvidenceStore,
): Promise<void> {
  // wp-env 11.12 rewrites a shared JSON cache during configuration loading.
  // Concurrent processes can truncate one another's runtime marker, making a
  // successfully started environment appear uninitialized. Keep its CLI serial.
  const [php, database, theme, themeHash, wordpress, coreHash, wordpressContainer, databaseContainer] = [
    await wpEnv(['run', 'cli', 'php', '-r', 'echo PHP_VERSION;']),
    await wpEnv(['run', 'cli', 'wp', 'db', 'query', 'SELECT VERSION();', '--skip-column-names']),
    await wpEnv(['run', 'cli', 'wp', 'theme', 'list', '--status=active', '--fields=name,version', '--format=json']),
    await wpEnv(['run', 'cli', 'wp', 'eval', "echo hash_file('sha256', get_stylesheet_directory() . '/style.css');"]),
    await wpEnv(['run', 'cli', 'wp', 'core', 'version']),
    await wpEnv(['run', 'cli', 'wp', 'eval', "echo hash_file('sha256', ABSPATH . 'wp-includes/version.php');"]),
    await wpEnv(['run', 'wordpress', 'sh', '-lc', 'cat /etc/hostname']),
    await wpEnv(['run', 'mysql', 'sh', '-lc', 'cat /etc/hostname']),
  ];
  const [wordpressImage, databaseImage] = await Promise.all([
    inspectRunningContainer(command, containerIdFromOutput(wordpressContainer.stdout)),
    inspectRunningContainer(command, containerIdFromOutput(databaseContainer.stdout)),
  ]);
  const observed = { php, database, theme, themeHash, wordpress, coreHash, wordpressContainer, databaseContainer, wordpressImage, databaseImage };
  environment.observations = await evidence.putJson(observed);
  environment.php.version = php.exitCode === 0 ? parsePhpVersion(firstLine(php.stdout)) ?? 'unobserved' : 'unobserved';
  environment.database.version = database.exitCode === 0 ? parseDatabaseVersion(firstLine(database.stdout)) ?? 'unobserved' : 'unobserved';
  environment.database.engine = /mariadb/i.test(environment.database.version) ? 'mariadb' : 'mysql';
  environment.database.image = databaseImage.exitCode === 0
    ? parseContainerImage(databaseImage.stdout, containerIdFromOutput(databaseContainer.stdout)) ?? 'unobserved'
    : 'unobserved';
  const activeTheme = parseActiveTheme(theme.stdout);
  environment.theme.name = theme.exitCode === 0 ? activeTheme?.name ?? 'unobserved' : 'unobserved';
  environment.theme.version = theme.exitCode === 0 ? activeTheme?.version ?? 'unobserved' : 'unobserved';
  environment.theme.fileHash = themeHash.exitCode === 0 ? parseSha256(firstLine(themeHash.stdout)) ?? 'unobserved' : 'unobserved';
  environment.wordpress.version = wordpress.exitCode === 0 ? parseWordPressVersion(firstLine(wordpress.stdout)) ?? 'unobserved' : 'unobserved';
  environment.wordpress.coreHash = coreHash.exitCode === 0 ? parseSha256(firstLine(coreHash.stdout)) ?? 'unobserved' : 'unobserved';
  environment.wordpress.dockerImage = wordpressImage.exitCode === 0
    ? parseContainerImage(wordpressImage.stdout, containerIdFromOutput(wordpressContainer.stdout)) ?? 'unobserved'
    : 'unobserved';
}

async function inspectRunningContainer(command: ProofCommandRunner, containerId: string): Promise<ProofCommandResult> {
  if (!containerId) return commandFailure('docker', new Error('wp-env did not return a running container ID.'));
  try {
    return await command('docker', ['container', 'inspect', '--format={{.Id}} {{.Image}} {{.Config.Image}}', containerId], {
      cwd: projectRoot,
      timeoutMs: PROOF_COMMAND_TIMEOUTS.docker,
      phase: 'docker-inspect',
    });
  } catch (error) {
    return commandFailure('docker', error);
  }
}

function parseActiveTheme(value: string): { name: string; version: string } | undefined {
  try {
    const parsed = JSON.parse(value) as Array<{ name?: unknown; version?: unknown }>;
    const active = parsed[0];
    if (typeof active?.name === 'string' && isThemeName(active.name) && typeof active.version === 'string' && isReleaseVersion(active.version)) {
      return { name: active.name, version: active.version };
    }
  } catch {
    // The raw WP-CLI output is retained as evidence by the caller.
  }
  return undefined;
}

function parsePhpVersion(value: string): string | undefined {
  return isRequiredPhpVersion(value) ? value : undefined;
}

function parseDatabaseVersion(value: string): string | undefined {
  return isDatabaseVersion(value) ? value : undefined;
}

function parseWordPressVersion(value: string): string | undefined {
  return isExactWordPressVersion(value) ? value : undefined;
}

function parseSha256(value: string): Sha256 | undefined {
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[a-f0-9]{64}$/i.test(hex) ? `sha256:${hex.toLowerCase()}` : undefined;
}

function parseContainerImage(value: string, expectedContainerId = ''): Sha256 | undefined {
  const match = /^([a-f0-9]{12,64})\s+(sha256:[a-f0-9]{64})\s+\S+$/im.exec(value.trim());
  return match && (!expectedContainerId || match[1]!.startsWith(expectedContainerId))
    ? parseSha256(match[2]!)
    : undefined;
}

function isExactWordPressVersion(value: string): boolean {
  // `WordPress/WordPress#7.1` tracks the 7.1 maintenance line. A patch
  // release is still the configured 7.1 runtime; another major/minor is not.
  return new RegExp(`^${REQUIRED_WORDPRESS_VERSION.replace('.', '\\.')}(?:\\.\\d+)?$`).test(value);
}

function isRequiredPhpVersion(value: string): boolean {
  return new RegExp(`^${REQUIRED_PHP_SERIES.replace('.', '\\.')}\\.\\d+$`).test(value);
}

function isDatabaseVersion(value: string): boolean {
  return /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z._-]+)?$/.test(value);
}

function isExactSemver(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isReleaseVersion(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isBrowserVersion(value: string): boolean {
  return /^\d+(?:\.\d+){1,3}$/.test(value);
}

function isThemeName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isNpmIntegrity(value: string): boolean {
  return /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isSha256Address(value: string | undefined): value is Sha256 {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function isPinnedFile(pin: ProofFilePin | undefined): pin is ProofFilePin {
  return Boolean(pin
    && isSha256Address(pin.sha256)
    && pin.bytes >= 0
    && isEvidenceReference(pin.evidence)
    && pin.evidence.sha256 === pin.sha256
    && pin.evidence.bytes === pin.bytes);
}

function isEvidenceReference(value: unknown): value is EvidenceReference {
  if (!isRecord(value)) return false;
  return isSha256Address(value.sha256 as string | undefined)
    && typeof value.bytes === 'number'
    && Number.isInteger(value.bytes)
    && value.bytes >= 0
    && typeof value.path === 'string'
    && /^evidence\/sha256\/[a-f0-9]{64}$/.test(value.path)
    && typeof value.mediaType === 'string';
}

function isRuntimeObservationMap(value: unknown): value is RuntimeObservationMap {
  return isRecord(value) && RUNTIME_OBSERVATION_COMMANDS.every((name) => isProofCommandResult(value[name]));
}

function isProofCommandResult(value: unknown): value is ProofCommandResult {
  if (!isRecord(value)) return false;
  return typeof value.command === 'string'
    && Array.isArray(value.args)
    && value.args.every((argument) => typeof argument === 'string')
    && (typeof value.exitCode === 'number' || value.exitCode === null)
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}

function containerIdFromOutput(value: string): string {
  const lines = value.trim().split(/\r?\n/).reverse();
  return lines.find((line) => /^[a-f0-9]{12,64}$/i.test(line.trim()))?.trim() ?? '';
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: ProofCommandOptions = {},
): Promise<ProofCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? PROOF_COMMAND_TIMEOUTS.wpEnv;
    const label = options.phase ?? command;
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    if (options.phase) process.stderr.write(`[block-runner proof] ${label} started (timeout ${timeoutMs}ms)\n`);
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      if (options.phase) {
        process.stderr.write(`[block-runner proof] ${label} ${timedOut ? 'timed out' : 'finished'} after ${durationMs}ms\n`);
      }
      resolve({
        command,
        args: [...args],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        exitCode,
        stdout,
        stderr,
        ...(options.phase ? { phase: options.phase } : {}),
        durationMs,
        ...(timedOut ? { timedOut: true } : {}),
      });
    };
    timeout = setTimeout(() => {
      timedOut = true;
      stderr += `Command exceeded ${timeoutMs}ms (${label}).`;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on('close', finish);
  });
}

function commandFailure(command: string, error: unknown): ProofCommandResult {
  return {
    command,
    args: [],
    exitCode: null,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  };
}

function resolveProjectRoot(modulePath: string): string {
  const moduleDirectory = path.dirname(modulePath);
  for (const candidate of [moduleDirectory, path.dirname(moduleDirectory), path.dirname(path.dirname(moduleDirectory))]) {
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Could not locate block-runner package root from ${modulePath}`);
}
