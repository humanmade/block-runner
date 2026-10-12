import { prepareSiteProof, runSiteProof, SITE_PROOF_GATES, type PreparedSiteProof, type SiteProofGate } from './site.js';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { validate } from '../gate/validate.js';
import { canonicalize } from '../gate/canonicalize.js';
import { PROOF_IMAGE_BASE64 } from './fixture-image.js';
import {
  PROOF_CLAIM_NAMES,
  PROOF_GATE_IDS,
  PROOF_PROFILES,
  evaluateProofProfile,
  proofClaimGates,
  type ProofGateId,
  type ProofGateRecord,
  type ProofClaimName,
  type ProofGateStatus,
  type ProofProfileName,
  type ProofProfileReport,
  type ProofRequirementClaim,
  type ProofRequirementReport,
} from './profiles.js';
import {
  compareThemeMarkup,
  copyThemeSnapshot,
  effectiveWpEnvConfig,
  effectiveWpEnvUrl,
  pinLocalPluginDirectories,
  prepareThemeProof,
  resolveLocalSource,
  themePreflightFailure,
  writeThemeRuntimeConfig,
  type PreparedThemeProof,
  type ThemeWpEnvConfig,
} from './theme.js';
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
  peerDependencies?: Record<string, string>;
};
const defaultWpEnvConfig = path.join(projectRoot, 'proof', 'wp-env.json');
const bundledProofDependencyPins = path.join(projectRoot, 'proof', 'dependency-pins.json');
const playwrightHelper = path.join(projectRoot, 'scripts', 'proof-playwright.mjs');
const themePlaywrightHelper = path.join(projectRoot, 'scripts', 'proof-theme-playwright.mjs');
const stagedZipDirectory = path.join(projectRoot, '.block-runner-proof-stage');
// Keep staging outside uploads: a nested Docker mount can create its parent as
// root on a fresh Linux host, preventing WordPress from creating media folders.
const stagedZipContainerDirectory = '/var/www/html/wp-content/block-runner-proof';
const REQUIRED_WORDPRESS_VERSION = '7.1' as const;
const REQUIRED_WORDPRESS_CORE_SOURCE = 'WordPress/WordPress#7.1' as const;
const REQUIRED_PHP_SERIES = '8.3' as const;
const PROOF_TOOLING = [
  '@wordpress/env',
  '@playwright/test',
  '@wordpress/e2e-test-utils-playwright',
  'axe-core',
  'pixelmatch',
  'pngjs',
] as const;
const BROWSER_PROOF_TOOLING = PROOF_TOOLING.slice(0, 4);
const THEME_PROOF_TOOLING = ['@wordpress/env', '@playwright/test'] as const;
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
  /** Exact version resolved from the source lockfile or packed proof pin snapshot. */
  version: string;
  /** npm Subresource Integrity value resolved from the source lockfile or packed proof pin snapshot. */
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

/**
 * A deliberately small, browser-observable reproduction of a generated
 * block's root layout.  This is separate from visual regression: it records
 * the editor-canvas DOM before and after the content cases that used to be
 * hidden by the extra InnerBlocks wrapper.
 */
export interface ProofBrowserMatrix {
  /** The computed display mode which must belong to the generated root. */
  rootLayout: 'grid' | 'flex';
  /** Exact native blocks emitted as children of the generated root. */
  directNativeChildren: readonly string[];
  /** The block-owned family declared by the shared stylesheet. */
  fontFamily: string;
  /** Text written to and then removed from the native heading in the iframe. */
  longContent: string;
  /** Deliberately non-default native Image proportions observed at narrow width. */
  image: { width: string; height: string };
  desktopViewport: { width: number; height: number };
  narrowViewport: { width: number; height: number };
  /**
   * Opt-in computed-style assertions for an author()-produced responsive
   * native mapping. The sibling deliberately repeats the source class outside
   * the generated root, so an omitted root prefix cannot masquerade as
   * component-local CSS.
   */
  responsive?: ProofResponsiveStyleMatrix;
}

export interface ProofResponsiveStyleMatrix {
  /** Selector relative to the generated root for the native child being proved. */
  targetSelector: string;
  /** Source class repeated on an unrelated paragraph outside the generated root. */
  siblingClass: string;
  /** Keep this intentionally narrow until another computed-style claim needs evidence. */
  property: 'font-size' | 'color';
  /** A separate sibling property makes the same fixture prove scoped residual CSS. */
  siblingProperty?: 'font-size' | 'color';
  /** Controlled baseline for the external same-class sentinel. */
  siblingInlineStyle?: string;
  /** At least narrow and desktop; boundary samples may be supplied as well. */
  samples: readonly {
    label: string;
    /** Browser viewport requested before measuring the actual proof surface. */
    viewport: { width: number; height: number };
    /**
     * Optional exact editor-canvas/frontend viewport. The helper adjusts the
     * top-level viewport to reach this width, then fails if WordPress's iframe
     * still cannot supply it. Use this for below/equal/above breakpoint proof.
     */
    surfaceViewport?: { width: number; height?: number };
    target: string;
    sibling: string;
  }[];
}

/**
 * Focused evidence for source styles adapted to Core Button, Image, and Group
 * markup.  It deliberately names only the browser-observable relationships
 * owned by the native adapter; it is not a general layout assertion surface.
 */
export interface NativeStyleAdapterMatrix {
  button: {
    /** Selector relative to the generated root for the Core Button wrapper. */
    wrapperSelector: string;
    /** Selector relative to the generated root for its interactive anchor. */
    linkSelector: string;
    /** Computed source padding which must belong to the anchor, never its wrapper. */
    linkPadding: { top: string; right: string; bottom: string; left: string };
    /** The authored hover transform and colour, each observed exactly on the anchor. */
    hover: { transform: string; backgroundColor: string };
    /** The authored keyboard focus outline on the anchor. */
    focusOutline: { style: string; width: string };
  };
  image: {
    selector: string;
    /** Preserved intrinsic evidence represented by the native image target. */
    sourceDimensions: { width: string; height: string; aspectRatio: string };
    alt: string;
    caption: string;
  };
  grid: {
    selector: string;
    samples: readonly { label: string; viewport: { width: number; height: number }; surfaceViewport?: { width: number; height?: number }; columns: number }[];
  };
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
  /**
   * Opt-in real-browser root-layout evidence. The helper refuses to record a
   * pass unless WordPress 7.1 rendered the generated root inside editor-canvas
   * at both declared viewport widths.
   */
  browserMatrix?: ProofBrowserMatrix;
  /**
   * A focused author()-produced responsive-style probe. Unlike browserMatrix,
   * it does not require the historical heading/image layout reproduction.
   */
  responsiveStyleMatrix?: ProofResponsiveStyleMatrix;
  /** Public author()-to-WordPress proof for the bounded native style adapters. */
  nativeStyleAdapterMatrix?: NativeStyleAdapterMatrix;
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

/** Immutable capability contract emitted for the exact archive under proof. */
export interface ProofArtifactContract {
  sha256: Sha256;
  capabilities: { patternOverrides: boolean };
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
  artifact?: ProofArtifactContract;
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
  /** Local block theme to prove through Site Editor template/part saves. */
  theme?: string;
  /** Controlled five-page site bundle; fixture deployment only. */
  site?: string;
  siteNegativeControl?: 'missing-content' | 'broken-asset' | 'wrong-target' | 'accordion-mismatch' | 'broken-mobile';
  /** Confirmed artifact capability contract. Capability-scoped claims bind it to pluginZip. */
  artifact?: ProofArtifactContract;
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
      /** Source package-lock.json, or the packed proof dependency pin snapshot. */
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
  theme: { name: string; version: string; fileHash: string; requiresPhp?: string };
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
  /** Pre-run capability contract and missing-input diagnosis retained with the raw gates. */
  requirements?: ProofRequirementReport;
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
  const profile = options.site ? 'site' : options.theme ? 'theme' : options.profile ?? 'full';
  if (!(profile in PROOF_PROFILES)) {
    throw new TypeError(`Unknown proof profile: ${String(profile)}`);
  }

  const outputDir = path.resolve(options.outputDir ?? path.join(process.cwd(), 'proof-receipts'));
  const receiptWriter = new ReceiptWriter(outputDir);
  const evidence = receiptWriter.evidence;
  const wpEnvConfig = path.resolve(options.wpEnvConfig ?? defaultWpEnvConfig);
  let preparedTheme: PreparedThemeProof | undefined;
  let preparedSite: PreparedSiteProof | undefined;
  let themeConfig: ThemeWpEnvConfig | undefined;
  let localDependencies: unknown[] = [];
  let preflightError: string | undefined;
  if (options.theme || options.site) {
    try {
      if (options.site) { preparedSite = await prepareSiteProof(options.site, evidence); preparedTheme = preparedSite.theme; }
      else preparedTheme = await prepareThemeProof(options.theme!, evidence);
      themeConfig = JSON.parse(await readFile(wpEnvConfig, 'utf8')) as ThemeWpEnvConfig;
      preflightError = themePreflightFailure(preparedTheme, themeConfig);
      if (!preflightError) {
        const dependencies = effectiveWpEnvConfig(themeConfig).plugins;
        localDependencies = await pinLocalPluginDirectories(dependencies, process.cwd(), evidence);
      }
    } catch (error) {
      preflightError = error instanceof Error ? error.message : String(error);
    }
  }
  const environment = await collectEnvironmentPins(options, evidence, wpEnvConfig, preparedTheme);
  // Resolve the declared claim before any adapter or Docker work begins. This is
  // retained even for blocked runs so a missing fixture cannot masquerade as N/A.
  const requirements = profile === 'theme' || profile === 'site'
    ? { ...reportThemeProofRequirements(preparedTheme, preflightError, environment), profile, requiredGates: PROOF_PROFILES[profile].requiredGates, localDependencies }
    : reportProofRequirements(profile, options.artifact, environment.plugin.zip?.sha256, options.fixture);
  const runtime = createRuntime(options, environment, wpEnvConfig, evidence, requirements.requiredGates, preparedTheme, themeConfig, preparedSite);
  // A supplied gate adapter owns its own proof environment. Otherwise report
  // an unavailable package before any profile's runtime gate can reach Docker.
  const unavailable = options.gateRunner ? [] : unavailableProofTooling(profile);
  const toolingError = unavailable.length > 0 ? unavailableProofToolingMessage(profile, unavailable) : undefined;
  const records: ProofGateRecord[] = [];

  try {
    for (const gate of requirements.requiredGates) {
      const startedAt = new Date().toISOString();
      const context: ProofGateContext = {
        profile,
        gate,
        fixture: options.fixture,
        artifact: options.artifact,
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
      const artifactError = requirements.missingInputs.find((reason) => reason.startsWith('Capability-scoped proof')
        || reason.startsWith('Confirmed artifact') || reason.startsWith('Pattern-verified proof'));
      const configurationError = preflightError ?? artifactError ?? ((profile === 'theme' || profile === 'site') ? missingThemeConfiguration(context, preparedTheme) : missingProofConfiguration(context));
      const unverifiedResult = gate !== 'headless_validation' && toolingError
        ? { status: 'blocked' as const, reason: toolingError }
        : configurationError
        ? { status: 'blocked' as const, reason: configurationError }
        : gate === 'accessibility_manual_review'
          ? await readManualAccessibilityReview(context, evidence)
        : options.gateRunner
          ? await options.gateRunner(context)
          : await runtime.run(context);
      const result = gate === 'environment_observation' && unverifiedResult?.status === 'pass'
        ? await enforceEnvironmentObservation(unverifiedResult, environment, evidence, profile === 'theme' || profile === 'site')
        : unverifiedResult;
      records.push(await asRecord(gate, result, context, startedAt));
    }
  } finally {
    await runtime.stop();
  }

  const profileReport = evaluateProofProfile({ name: profile, requiredGates: requirements.requiredGates, optionalGates: [] }, records);
  const receipt: ProofReceiptDocument = {
    schemaVersion: 1,
    kind: 'block-runner.wordpress-proof',
    createdAt: new Date().toISOString(),
    selectedProfile: profile,
    ok: profileReport.ok,
    environment,
    requirements,
    gates: records,
    profile: profileReport,
  };
  const receiptReference = await receiptWriter.write(receipt);
  return { ok: profileReport.ok, profile: profileReport, receipt, receiptReference };
}

/**
 * Build the requirement report before a runner invokes Docker, Playwright, or
 * a caller adapter. The original named profiles remain byte-for-byte in scope;
 * only capability-scoped profiles need an immutable artifact contract.
 */
export function reportProofRequirements(
  profile: ProofProfileName,
  artifact: ProofArtifactContract | undefined,
  observedPluginZip: Sha256 | undefined,
  fixture?: ProofFixture,
): ProofRequirementReport {
  const capabilityScoped = (PROOF_CLAIM_NAMES as readonly string[]).includes(profile);
  const validArtifact = artifact != null
    && typeof artifact.sha256 === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(artifact.sha256)
    && typeof artifact.capabilities?.patternOverrides === 'boolean';
  const artifactMatches = validArtifact && observedPluginZip !== undefined && artifact.sha256 === observedPluginZip;
  const patternOverrides = validArtifact && artifactMatches && artifact.capabilities.patternOverrides;
  const missingInputs: string[] = [];
  if (capabilityScoped && !validArtifact) {
    missingInputs.push('Capability-scoped proof requires a well-formed confirmed artifact contract with SHA-256 and capabilities.');
  } else if (capabilityScoped && !observedPluginZip) {
    missingInputs.push('Capability-scoped proof requires a readable plugin ZIP so its artifact SHA-256 can be confirmed.');
  } else if (capabilityScoped && !artifactMatches) {
    missingInputs.push('Confirmed artifact SHA-256 does not match the supplied plugin ZIP.');
  }
  if (profile === 'pattern-verified' && !patternOverrides) {
    missingInputs.push('Pattern-verified proof requires a hash-matched artifact contract that declares patternOverrides.');
  }
  const requiredGates = [...PROOF_PROFILES[profile].requiredGates];
  // An artifact that declares overrides must complete the actual lifecycle
  // before its scoped editor/fidelity result can make that claim.
  if (patternOverrides && (profile === 'editor-verified' || profile === 'fidelity-checked')
    && !requiredGates.includes('pattern_overrides')) requiredGates.push('pattern_overrides');
  if (requiredGates.some((gate) => ['plugin_activation', 'php_registry', 'rest_block_type', 'client_registry', 'editor_inserter', 'editor_field_editing', 'editor_save', 'editor_reopen'].includes(gate)) && !fixture?.blockName) {
    missingInputs.push('Required runtime/editor gates need fixture.blockName.');
  }
  if (requiredGates.includes('editor_field_editing') && (!fixture?.editableFields || fixture.editableFields.length === 0)) {
    missingInputs.push('Editor verification requires fixture.editableFields.');
  }
  if (requiredGates.some((gate) => ['frontend_status', 'frontend_semantics', 'frontend_links', 'frontend_media', 'frontend_assets', 'frontend_runtime_errors'].includes(gate)) && !fixture?.frontend?.url) {
    missingInputs.push('Frontend and fidelity verification require fixture.frontend.url.');
  }
  if (requiredGates.includes('pattern_overrides')) {
    const pattern = fixture?.patternOverrides;
    if (!fixture?.blockName || !pattern?.title || !pattern.canonicalContent || pattern.instances?.length !== 2
      || !pattern.canonicalUpdate?.content || !pattern.reset || !Array.isArray(pattern.requiredBindings) || pattern.requiredBindings.length === 0
      || !pattern.negative?.value || !pattern.negative.fallback || !pattern.structuralPolicy || !Array.isArray(pattern.requiredBindings)) {
      missingInputs.push('Pattern verification requires the complete two-instance lifecycle fixture.');
    } else {
      const canonical = generatedBlockPatternCoverage(pattern.canonicalContent, fixture.blockName, pattern.requiredBindings);
      const update = generatedBlockPatternCoverage(pattern.canonicalUpdate.content, fixture.blockName, pattern.requiredBindings);
      if (!canonical.ok || !update.ok) missingInputs.push('Pattern verification requires every required binding inside generated block markup in both canonical versions.');
    }
  }
  if (requiredGates.includes('visual_regression') && (!fixture?.visual?.expectedPath || typeof fixture.visual.threshold !== 'number')) {
    missingInputs.push('Visual fidelity verification requires fixture.visual.expectedPath and threshold.');
  }
  if (requiredGates.some((gate) => ['accessibility_editor', 'accessibility_frontend', 'accessibility_manual_review'].includes(gate)) && !fixture?.accessibility) {
    missingInputs.push('Accessibility gates require a separately declared fixture.accessibility scope.');
  }
  const claims: ProofRequirementClaim[] = capabilityScoped
    ? [{ claim: profile as ProofClaimName, status: missingInputs.length === 0 ? 'required' : 'blocked', requiredGates: [...requiredGates] }]
    : [];
  if (patternOverrides && (profile === 'editor-verified' || profile === 'fidelity-checked')) {
    claims.push({ claim: 'pattern-verified', status: missingInputs.length === 0 ? 'required' : 'blocked', requiredGates: proofClaimGates('pattern-verified') });
  }
  const artifactStatus = !capabilityScoped ? 'not_requested'
    : !artifact ? 'missing'
    : !validArtifact ? 'invalid'
    : !observedPluginZip ? 'missing'
    : artifactMatches ? 'confirmed' : 'stale';
  return {
    profile,
    artifact: {
      status: artifactStatus,
      ...(artifact ? { declaredSha256: artifact.sha256 } : {}),
      ...(observedPluginZip ? { observedPluginZipSha256: observedPluginZip } : {}),
      ...(validArtifact ? { capabilities: { patternOverrides: artifact.capabilities.patternOverrides } } : {}),
    },
    requiredGates,
    claims,
    expectedEnvironment: requiredGates.length === 1
      ? ['pinned generator input']
      : ['pinned generator input', 'plugin ZIP', 'WordPress 7.1, PHP 8.3, MySQL, and Chromium observations'],
    missingInputs,
  };
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
    if (context.profile === 'pattern-verified') {
      if (!context.artifact?.capabilities?.patternOverrides || context.artifact.sha256 !== environment.plugin.zip?.sha256) {
        return 'Pattern-verified proof requires a confirmed artifact contract whose SHA-256 matches the supplied plugin ZIP.';
      }
    }
    if (!fixture?.blockName || !pattern?.title || !pattern.canonicalContent || pattern.instances?.length !== 2
      || !pattern.canonicalUpdate?.content || !pattern.reset || !Array.isArray(pattern.requiredBindings) || pattern.requiredBindings.length === 0
      || !pattern.negative?.value || !pattern.negative.fallback || !pattern.structuralPolicy || !Array.isArray(pattern.requiredBindings)) {
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
  themeProfile = false,
): Promise<ProofGateResult> {
  const unobserved = await requiredRuntimeObservationFailures(environment, evidenceStore, themeProfile);
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
  preparedTheme?: PreparedThemeProof,
): Promise<ProofEnvironment> {
  // npm deliberately excludes a package's package-lock.json from its tarball.
  // Source and CI runs use the full root lock; packed consumers instead pin the
  // checked-in proof snapshot so receipt integrity does not depend on a
  // consumer's unrelated lockfile.
  const packageLock = existsSync(path.join(projectRoot, 'package-lock.json'))
    ? path.join(projectRoot, 'package-lock.json')
    : bundledProofDependencyPins;
  const [packagePin, lockPin, configPin, zipPin, inputPin, wordpressPackages, wpEnvPins] = await Promise.all([
    pinFile(path.join(projectRoot, 'package.json'), evidence),
    pinFile(packageLock, evidence).catch(() => undefined),
    pinFile(wpEnvConfig, evidence),
    options.pluginZip ? pinFile(path.resolve(options.pluginZip), evidence).catch(() => undefined) : undefined,
    preparedTheme ? preparedTheme.snapshot : pinInput(options, evidence),
    collectWordPressPackagePins(packageLock).catch(() => ({})),
    readWpEnvPins(wpEnvConfig, Boolean(options.theme || options.site)).catch(() => ({ coreSource: 'unobserved', phpVersion: 'unobserved' })),
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
    theme: preparedTheme
      ? { name: preparedTheme.slug, version: preparedTheme.version, fileHash: 'unobserved', ...(preparedTheme.requiresPhp ? { requiresPhp: preparedTheme.requiresPhp } : {}) }
      : { name: 'unobserved', version: 'unobserved', fileHash: 'unobserved' },
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

async function readWpEnvPins(file: string, themeProfile = false): Promise<{ coreSource: string; phpVersion: string }> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(parsed)) return { coreSource: 'unobserved', phpVersion: 'unobserved' };
  if (!themeProfile) {
    return {
      coreSource: typeof parsed.core === 'string' ? parsed.core : 'unobserved',
      phpVersion: typeof parsed.phpVersion === 'string' ? parsed.phpVersion : 'unobserved',
    };
  }
  const effective = effectiveWpEnvConfig(parsed as ThemeWpEnvConfig);
  return {
    coreSource: effective.core ?? 'unobserved',
    phpVersion: effective.phpVersion ?? 'unobserved',
  };
}

function reportThemeProofRequirements(
  theme: PreparedThemeProof | undefined,
  preflightError: string | undefined,
  environment: ProofEnvironment,
): ProofRequirementReport {
  const missingInputs = [
    ...(!theme ? [preflightError ?? 'Theme proof requires a readable local theme directory.'] : []),
    ...(preflightError && theme ? [preflightError] : []),
  ];
  return {
    profile: 'theme',
    artifact: { status: 'not_requested' },
    requiredGates: [...PROOF_PROFILES.theme.requiredGates],
    claims: [],
    expectedEnvironment: [
      'pinned theme source snapshot',
      `WordPress ${REQUIRED_WORDPRESS_VERSION}, caller-selected PHP, local dependency plugins, MySQL, and Chromium observations`,
    ],
    missingInputs,
  };
}

function missingThemeConfiguration(context: ProofGateContext, theme: PreparedThemeProof | undefined): string | undefined {
  if (!theme) return 'Theme proof requires a readable local theme directory.';
  if (!context.environment.input) return 'Theme proof receipt is missing its content-addressed source snapshot.';
  if (context.gate === 'theme_roundtrip' && theme.files.length === 0) return 'Theme proof found no templates or template parts to round-trip.';
  return undefined;
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
  requiredGates: readonly ProofGateId[],
  preparedTheme?: PreparedThemeProof,
  sourceThemeConfig?: ThemeWpEnvConfig,
  preparedSite?: PreparedSiteProof,
): { run: (context: ProofGateContext) => Promise<ProofGateResult>; stop: () => Promise<void> } {
  const selectedProfile = preparedSite ? 'site' : preparedTheme ? 'theme' : options.profile ?? 'full';
  let environmentStarted = false;
  let staticPluginDeactivated = false;
  let deactivationEvidence: EvidenceReference | undefined;
  let preparedNativeStyleMedia: { url: string; evidence: EvidenceReference } | undefined;
  let browserResults: Partial<Record<ProofGateId, ProofGateResult>> | undefined;
  let deactivatedBrowserResults: Partial<Record<ProofGateId, ProofGateResult>> | undefined;
  let stagedPluginZip: { host: string; container: string } | undefined;
  let publication: ProofPublication | undefined;
  let preparedPattern: PreparedSyncedPattern | undefined;
  let startupFailure: ProofGateResult | undefined;
  let effectiveRuntimeConfig = wpEnvConfig;
  let stagedThemeDirectory: string | undefined;
  let runtimeThemeConfig: string | undefined;
  let themeStageRoot: string | undefined;
  let siteResults: Partial<Record<SiteProofGate, ProofGateResult>> | undefined;
  const command = options.commandRunner ?? runCommand;

  const wpEnv = async (args: string[], phase = `wp-env:${args.slice(0, 3).join(' ')}`): Promise<ProofCommandResult> => {
    const result = await command('npx', ['--no-install', 'wp-env', `--config=${effectiveRuntimeConfig}`, ...args], {
      cwd: projectRoot,
      timeoutMs: args[0] === 'start' ? PROOF_COMMAND_TIMEOUTS.wpEnvStart : PROOF_COMMAND_TIMEOUTS.wpEnv,
      phase,
    });
    return result;
  };
  const logged = async (result: ProofCommandResult): Promise<EvidenceReference> =>
    evidence.putJson(result);
  const start = async (): Promise<ProofGateResult> => {
    if (environmentStarted) return { status: 'pass', reason: 'Pinned wp-env is already running.' };
    if (startupFailure) return startupFailure;
    const unavailable = unavailableProofTooling(selectedProfile);
    if (unavailable.length > 0) {
      startupFailure = { status: 'blocked', reason: unavailableProofToolingMessage(selectedProfile, unavailable) };
      return startupFailure;
    }
    if (options.execute === false) return { status: 'blocked', reason: 'Proof execution was disabled.' };
    if (!options.pluginZip && !preparedTheme) return { status: 'blocked', reason: 'Runtime proof requires --plugin-zip or --theme.' };
    // A browser is a separate, opt-in Playwright download. Check for it before
    // Docker starts so a missing local browser produces an actionable setup
    // diagnostic instead of a later generic browser-proof failure. Command
    // runners are test/adaptor-owned environments and may supply their own
    // browser implementation, so they retain control of that prerequisite.
    if (!options.commandRunner && unavailableChromiumBrowser()) {
      startupFailure = { status: 'blocked', reason: unavailableChromiumBrowserMessage() };
      return startupFailure;
    }
    if (preparedTheme && sourceThemeConfig) {
      try {
        const stageParent = path.join(projectRoot, '.block-runner-theme-stage');
        await mkdir(stageParent, { recursive: true });
        themeStageRoot = await mkdtemp(path.join(stageParent, `${preparedTheme.snapshot.sha256.slice(7)}-`));
        stagedThemeDirectory = path.join(themeStageRoot, preparedTheme.slug);
        await copyThemeSnapshot(preparedTheme, stagedThemeDirectory);
        runtimeThemeConfig = path.join(themeStageRoot, 'wp-env.theme-proof.json');
        await writeThemeRuntimeConfig(sourceThemeConfig, wpEnvConfig, preparedTheme, stagedThemeDirectory, runtimeThemeConfig);
        effectiveRuntimeConfig = runtimeThemeConfig;
      } catch (error) {
        startupFailure = { status: 'blocked', reason: `Could not stage the pinned theme source/config: ${error instanceof Error ? error.message : String(error)}` };
        return startupFailure;
      }
    }
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
    const staged = preparedTheme ? { status: 'pass' as const } : await stagePluginZip();
    if (staged.status !== 'pass') { startupFailure = staged; return startupFailure; }
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
      if (mode === 'active' && requiredGates.includes('pattern_overrides') && options.fixture.patternOverrides) {
        const prepared = await prepareSyncedPattern();
        if (!prepared) {
          browserResults = Object.fromEntries(browserGateIds.map((gate) => [gate, {
              status: 'blocked',
              reason: 'Could not create and read the canonical synced wp_block fixture.',
            }])) as Partial<Record<ProofGateId, ProofGateResult>>;
          return browserResults;
        }
      }
      if (mode === 'active' && options.fixture.nativeStyleAdapterMatrix) {
        preparedNativeStyleMedia = await prepareNativeStyleAdapterMedia();
        if (!preparedNativeStyleMedia) {
          browserResults = Object.fromEntries(browserGateIds.map((gate) => [gate, {
            status: 'blocked',
            reason: 'Could not prepare the native style adapter proof image at its authored upload URL.',
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
      const browserFixture = preparedNativeStyleMedia && fixture.frontend
        ? { ...fixture, frontend: { ...fixture.frontend, expectedMedia: [preparedNativeStyleMedia.url] } }
        : fixture;
      await writeFile(config, JSON.stringify({ fixture: browserFixture, profile: options.profile, requiredGates, baseUrl: 'http://localhost:8888', mode, publication }), 'utf8');
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
            evidence: [...(value.evidence ?? []), ...artifacts, logs, ...(preparedNativeStyleMedia ? [preparedNativeStyleMedia.evidence] : []), ...(phaseEvidence ? [phaseEvidence] : [])],
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

  /**
   * The utility hero's authored image is a site-relative upload URL, not a
   * media-control replacement. Materialize those exact bytes at that URL so
   * frontend_media proves the emitted source can load in WordPress.
   */
  const prepareNativeStyleAdapterMedia = async (): Promise<{ url: string; evidence: EvidenceReference } | undefined> => {
    if (preparedNativeStyleMedia) return preparedNativeStyleMedia;
    const php = [
      `$png = base64_decode('${PROOF_IMAGE_BASE64}');`,
      "$uploadDirFilter = static function ($uploads) { $uploads['path'] = $uploads['basedir']; $uploads['url'] = $uploads['baseurl']; $uploads['subdir'] = ''; return $uploads; };",
      "add_filter('upload_dir', $uploadDirFilter);",
      "try { $directory = wp_upload_dir(); $existing = $directory['basedir'] . '/block-runner-editor.png'; $upload = is_file($existing) ? array('file' => $existing, 'url' => $directory['baseurl'] . '/block-runner-editor.png') : wp_upload_bits('block-runner-editor.png', null, $png); } finally { remove_filter('upload_dir', $uploadDirFilter); }",
      "if (!empty($upload['error'])) { throw new RuntimeException('Native style adapter proof image upload failed: ' . $upload['error']); }",
      "$file = $upload['file'];",
      "if (!is_readable($file) || hash_file('sha256', $file) !== hash('sha256', $png)) { throw new RuntimeException('Native style adapter proof image bytes were not retained correctly.'); }",
      "$expectedUrl = content_url('/uploads/block-runner-editor.png');",
      "if ($upload['url'] !== $expectedUrl) { throw new RuntimeException('Native style adapter proof image upload URL did not match the authored source.'); }",
      "echo json_encode(array('url' => $upload['url']));",
    ].join(' ');
    const { result, evidence } = await wp(php);
    if (result.exitCode !== 0) return undefined;
    try {
      const observed = JSON.parse(result.stdout.trim()) as { url?: unknown };
      if (typeof observed.url !== 'string' || !observed.url) return undefined;
      preparedNativeStyleMedia = { url: observed.url, evidence };
      return preparedNativeStyleMedia;
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

      if (preparedSite && SITE_PROOF_GATES.includes(context.gate as SiteProofGate)) {
        if (!siteResults) {
          if (!stagedThemeDirectory || !sourceThemeConfig) return { status: 'blocked', reason: 'Site proof requires the owned staged theme and effective config.' };
          const result = await runSiteProof({
            site: preparedSite, negativeControl: options.siteNegativeControl, stagedTheme: stagedThemeDirectory,
            baseUrl: effectiveWpEnvUrl(sourceThemeConfig), helper: path.join(projectRoot, 'scripts', 'proof-site-playwright.mjs'), evidence,
            wp: async (php) => wpEnv(['run', 'cli', 'wp', 'eval', php]),
            command: async (name, args) => command(name, args, { cwd: projectRoot, timeoutMs: PROOF_COMMAND_TIMEOUTS.browser, phase: 'browser-site-proof' }),
          });
          siteResults = result.gates;
          if (result.theme && preparedTheme) Object.assign(preparedTheme, result.theme);
          if (isRecord(result.browser) && typeof result.browser.version === 'string' && typeof result.browser.revision === 'string') {
            environment.browser.version = result.browser.version;
            environment.browser.revision = result.browser.revision;
          }
          await collectObservedRuntimePins(wpEnv, command, environment, evidence);
        }
        return siteResults[context.gate as SiteProofGate] ?? { status: 'blocked', reason: 'Site gate result missing.' };
      }
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
    if (context.gate === 'theme_activation' && preparedTheme) {
      const activated = await wpEnv(['run', 'cli', 'wp', 'theme', 'activate', preparedTheme.slug]);
      const activationLog = await logged(activated);
      if (activated.exitCode !== 0) return { status: 'fail', reason: `WordPress could not activate local theme ${preparedTheme.slug}.`, evidence: [activationLog] };
      await collectObservedRuntimePins(wpEnv, command, environment, evidence);
      const dependencySources = sourceThemeConfig ? effectiveWpEnvConfig(sourceThemeConfig).plugins : [];
      const dependencySlugs = dependencySources.map((source) => {
        const absolute = resolveLocalSource(source, process.cwd());
        return path.extname(absolute).toLowerCase() === '.php' ? path.basename(absolute, '.php') : path.basename(absolute);
      });
      const deps64 = Buffer.from(JSON.stringify(dependencySlugs), 'utf8').toString('base64');
      const php = `require_once ABSPATH . 'wp-admin/includes/plugin.php'; $deps = json_decode(base64_decode('${deps64}'), true); $active = (array) get_option('active_plugins', array()); $matches = array(); foreach (get_plugins() as $file => $plugin) { $slug = dirname($file); if ($slug === '.' || $slug === '') { $slug = basename($file, '.php'); } if (in_array($slug, $deps, true)) { $matches[] = array('slug' => $slug, 'file' => $file, 'active' => in_array($file, $active, true)); } } echo json_encode(array('dependencies' => $matches, 'theme' => get_stylesheet()));`;
      const { result: dependencyResult, evidence: dependencyLog } = await wp(php);
      let dependencyObservation: unknown;
      try { dependencyObservation = JSON.parse(dependencyResult.stdout.trim()); } catch { dependencyObservation = { raw: dependencyResult.stdout }; }
      const activeDependencies = isRecord(dependencyObservation) && Array.isArray(dependencyObservation.dependencies)
        ? dependencyObservation.dependencies as Array<{ slug?: string; active?: boolean }>
        : [];
      const dependenciesPassed = dependencySlugs.every((slug) => activeDependencies.some((plugin) => plugin.slug === slug && plugin.active));
      const details = { theme: preparedTheme.slug, dependencySources, dependencySlugs, dependencyObservation, dependenciesPassed };
      return dependencyResult.exitCode === 0 && dependenciesPassed
        ? { status: 'pass', evidence: [activationLog, dependencyLog], details }
        : { status: 'fail', reason: 'Theme activated, but one or more caller-provided local dependency plugins are not active.', evidence: [activationLog, dependencyLog], details };
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
        const unobserved = await requiredRuntimeObservationFailures(environment, evidence, selectedProfile === 'theme' || selectedProfile === 'site');
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

      if (context.gate === 'theme_roundtrip' && preparedTheme) {
        return runThemeRoundtripWithRuntimeMarker(preparedTheme, preparedSite ? path.join(projectRoot, 'scripts', 'proof-site-playwright.mjs') : themePlaywrightHelper, command, options, sourceThemeConfig, wpEnv, logged, evidence, environment);
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
      if (!options.keepEnvironment && themeStageRoot) await rm(themeStageRoot, { recursive: true, force: true }).catch(() => undefined);
      // Keep the staged ZIP and browser work alongside the receipt until the
      // caller explicitly cleans its proof artifacts. Failed runs need these too.
    },
  };
}

async function runThemeBrowserProof(
  theme: PreparedThemeProof,
  helper: string,
  command: ProofCommandRunner,
  options: ProofRunOptions,
  wpEnvConfig: ThemeWpEnvConfig | undefined,
  runtimeMarker: string,
): Promise<{ command: ProofCommandResult; report?: Record<string, unknown> }> {
  try {
    await access(helper, fsConstants.R_OK);
  } catch {
    return { command: commandFailure(process.execPath, new Error('Bundled Site Editor theme proof helper is unavailable.')) };
  }
  const workRoot = path.resolve(options.outputDir ?? 'proof-receipts');
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(path.join(workRoot, 'theme-browser-'));
  const configPath = path.join(work, 'proof.json');
  const reportPath = path.join(work, 'result.json');
  const files = [];
  for (const file of theme.files) {
    const fixed = await canonicalize(file.content);
    files.push({ file: file.file, kind: file.kind, content: file.content, fix: fixed.output ?? file.content });
  }
  let baseUrl: string;
  try {
    baseUrl = effectiveWpEnvUrl(wpEnvConfig ?? {});
  } catch (error) {
    return { command: commandFailure(process.execPath, error) };
  }
  await writeFile(configPath, JSON.stringify({ theme: theme.slug, files, baseUrl, runtimeMarker }), 'utf8');
  const result = await command(process.execPath, [helper, '--config', configPath, '--out', reportPath], {
    cwd: projectRoot,
    timeoutMs: PROOF_COMMAND_TIMEOUTS.browser,
    phase: 'browser-theme-save',
  });
  try {
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    return { command: result, report };
  } catch (error) {
    return { command: { ...result, exitCode: null, stderr: `${result.stderr}\nCould not read theme browser report: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

async function runThemeRoundtripWithRuntimeMarker(
  theme: PreparedThemeProof,
  helper: string,
  command: ProofCommandRunner,
  options: ProofRunOptions,
  wpEnvConfig: ThemeWpEnvConfig | undefined,
  wpEnv: (args: string[]) => Promise<ProofCommandResult>,
  logged: (result: ProofCommandResult) => Promise<EvidenceReference>,
  evidence: EvidenceStore,
  environment: ProofEnvironment,
): Promise<ProofGateResult> {
  const originalRead = await wpEnv(['run', 'cli', 'wp', 'option', 'get', 'blogdescription', '--format=json']);
  const originalDescription = originalRead.exitCode === 0 ? parseWpCliJsonString(originalRead.stdout) : undefined;
  if (originalDescription === undefined) {
    const readEvidence = await logged(originalRead);
    return { status: 'blocked', reason: 'Could not safely capture wp-env blogdescription before the theme save proof.', evidence: [readEvidence] };
  }

  const marker = `block-runner-theme-proof:${randomUUID()}`;
  const markerSet = await wpEnv(['run', 'cli', 'wp', 'option', 'update', 'blogdescription', marker]);
  const markerSetEvidence = await logged(markerSet);
  let result: ProofGateResult = { status: 'blocked', reason: 'Site Editor theme save proof did not complete.' };
  let cleanupEvidence: EvidenceReference | undefined;
  try {
    if (markerSet.exitCode !== 0) {
      result = { status: 'blocked', reason: 'Could not bind the browser to this run’s wp-env site before saving templates.', evidence: [markerSetEvidence] };
    } else {
      const browserResult = await runThemeBrowserProof(theme, helper, command, options, wpEnvConfig, marker);
      const browserEvidence = await logged(browserResult.command);
      if (!browserResult.report) {
        result = { status: 'blocked', reason: 'Site Editor theme save proof did not produce a report.', evidence: [browserEvidence] };
      } else {
        const browserObservation = browserResult.report.browser;
        if (isRecord(browserObservation)) {
          if (typeof browserObservation.version === 'string') environment.browser.version = browserObservation.version;
          if (typeof browserObservation.revision === 'string') environment.browser.revision = browserObservation.revision;
        }
        const files = Array.isArray(browserResult.report.files) ? browserResult.report.files as Array<Record<string, unknown>> : [];
        const expectedByName = new Map(theme.files.map((file) => [file.file, file]));
        const reportByName = new Map(files.map((file) => [String(file.file ?? ''), file]));
        const exactFileSet = files.length === theme.files.length
          && reportByName.size === files.length
          && theme.files.every((file) => reportByName.has(file.file))
          && files.every((file) => expectedByName.has(String(file.file ?? '')));
        const comparedFiles = exactFileSet ? await Promise.all(theme.files.map(async (expected) => {
          const actual = reportByName.get(expected.file)!;
          const fixedSource = await canonicalize(expected.content);
          const fixedMarkup = fixedSource.output ?? expected.content;
          const loaded = typeof actual.loadedRaw === 'string'
            ? compareThemeMarkup(expected.content, actual.loadedRaw, theme.slug)
            : undefined;
          const saved = typeof actual.savedRaw === 'string'
            ? compareThemeMarkup(expected.content, actual.savedRaw, theme.slug)
            : undefined;
          const fixed = typeof actual.savedRaw === 'string'
            ? compareThemeMarkup(fixedMarkup, actual.savedRaw, theme.slug)
            : undefined;
          const serialized = typeof actual.editorSave === 'object' && actual.editorSave !== null
            && typeof (actual.editorSave as Record<string, unknown>).serialized === 'string'
            && typeof actual.savedRaw === 'string'
            ? compareExactMarkup((actual.editorSave as Record<string, unknown>).serialized as string, actual.savedRaw)
            : undefined;
          const passed = actual.status === 'pass' && loaded?.equal === true && saved?.equal === true && serialized?.equal === true;
          if (loaded) actual.sourceLoadComparison = loaded;
          if (saved) actual.sourceComparison = saved;
          if (fixed) actual.fixComparison = fixed;
          if (serialized) actual.editorRestComparison = serialized;
          actual.status = passed ? 'pass' : 'fail';
          if (!passed) {
            actual.reason = loaded?.equal !== true
              ? 'Loaded source entity differed from the source file after removing only the matching theme attribute.'
              : saved?.equal !== true
                ? 'Saved REST content differed from the source after removing only the matching theme attribute.'
                : serialized?.equal !== true
                  ? 'Fresh REST content.raw differed from the mounted editor serialization saved through core data.'
                  : actual.reason ?? 'Browser proof did not confirm source loading and persistence.';
            const firstDifferenceByte = loaded?.firstDifferenceByte ?? saved?.firstDifferenceByte ?? serialized?.firstDifferenceByte;
            if (firstDifferenceByte !== undefined) actual.firstDifferenceByte = firstDifferenceByte;
          }
          return actual;
        })) : [];
        browserResult.report.files = comparedFiles;
        const reportEvidence = await evidence.putJson(browserResult.report);
        const runtimeBinding = isRecord(browserResult.report.runtimeBinding) && browserResult.report.runtimeBinding.verified === true;
        const passed = browserResult.command.exitCode === 0 && runtimeBinding && exactFileSet && comparedFiles.every((file) => file.status === 'pass');
        const completedWithDifferences = runtimeBinding && exactFileSet && comparedFiles.some((file) => file.status === 'fail');
        result = {
          status: passed ? 'pass' : completedWithDifferences ? 'fail' : 'blocked',
          reason: passed ? undefined : completedWithDifferences ? 'One or more theme templates or parts changed during a Site Editor save.' : !runtimeBinding ? 'Site Editor theme save proof did not confirm the browser target as this wp-env runtime.' : 'Site Editor theme save proof did not produce a complete unique per-file result.',
          evidence: [browserEvidence, reportEvidence],
          details: browserResult.report,
        };
      }
    }
  } catch (error) {
    result = { status: 'fail', reason: `Theme Site Editor proof errored: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    const currentRead = await wpEnv(['run', 'cli', 'wp', 'option', 'get', 'blogdescription', '--format=json']);
    const currentDescription = currentRead.exitCode === 0 ? parseWpCliJsonString(currentRead.stdout) : undefined;
    if (currentDescription === marker) {
      const restored = await wpEnv(['run', 'cli', 'wp', 'option', 'update', 'blogdescription', originalDescription]);
      cleanupEvidence = await logged(restored);
      if (restored.exitCode !== 0) result = { ...result, status: 'fail', reason: 'Theme proof could not restore the original blogdescription marker.', evidence: [...(result.evidence ?? []), cleanupEvidence] };
    } else {
      cleanupEvidence = await evidence.putJson({ markerRestored: false, currentValueIsMarker: currentDescription === marker, readExitCode: currentRead.exitCode });
      result = { ...result, status: 'fail', reason: 'Theme proof marker changed or could not be read; no setting was overwritten during cleanup.', evidence: [...(result.evidence ?? []), cleanupEvidence] };
    }
  }
  return { ...result, evidence: dedupeEvidence([...(result.evidence ?? []), ...(cleanupEvidence ? [cleanupEvidence] : [])]) };
}

function parseWpCliJsonString(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function compareExactMarkup(expected: string, actual: string): {
  equal: boolean;
  firstDifferenceByte?: number;
  expectedBytes: number;
  actualBytes: number;
} {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  let offset = 0;
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) offset++;
  const equal = offset === left.length && offset === right.length;
  return {
    equal,
    ...(equal ? {} : { firstDifferenceByte: offset }),
    expectedBytes: left.length,
    actualBytes: right.length,
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
  themeProfile = false,
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
    ...(themeProfile ? [] : [requirePin('plugin.zip', environment.plugin.zip)]),
  ]);
  if (missing(environment.generator.package)) failures.push('generator.package');
  if (!isReleaseVersion(environment.generator.version)) failures.push('generator.version');
  if (environment.wordpress.requestedVersion !== REQUIRED_WORDPRESS_VERSION) failures.push('wordpress.requestedVersion');
  if (environment.wordpress.coreSource !== REQUIRED_WORDPRESS_CORE_SOURCE) failures.push('wordpress.coreSource');
  if (themeProfile
    ? !/^\d+\.\d+(?:\.\d+)?$/.test(environment.php.requestedVersion)
    : environment.php.requestedVersion !== REQUIRED_PHP_SERIES) failures.push('php.requestedVersion');
  if (!['mysql', 'mariadb'].includes(environment.database.engine)) failures.push('database.engine');
  if (environment.browser.engine !== 'chromium') failures.push('browser.engine');
  if (!isExactSemver(environment.wordpress.wpEnv)) failures.push('wordpress.wpEnv');
  if (!isExactSemver(environment.browser.playwright)) failures.push('browser.playwright');
  if (!/^v\d+\.\d+\.\d+$/.test(environment.node.version)) failures.push('node.version');

  if (!themeProfile) {
    if (missing(environment.plugin.slug)) failures.push('plugin.slug');
    if (missing(environment.plugin.name)) failures.push('plugin.name');
    if (!isReleaseVersion(environment.plugin.version)) failures.push('plugin.version');
    if (missing(environment.plugin.file)) failures.push('plugin.file');
  }
  if (!isExactWordPressVersion(environment.wordpress.version)) failures.push('wordpress.version');
  if (!isSha256Address(environment.wordpress.coreHash)) failures.push('wordpress.coreHash');
  if (!isSha256Address(environment.wordpress.dockerImage)) failures.push('wordpress.dockerImage');
  if (themeProfile
    ? !/^\d+\.\d+\.\d+$/.test(environment.php.version)
    : !isRequiredPhpVersion(environment.php.version)) failures.push('php.version');
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
    if (themeProfile) {
      if (observed.theme.name !== environment.theme.name) failures.push('observations.theme.name');
      if (!versionAtLeast(observed.php.version, environment.theme.requiresPhp ?? '0.0')) failures.push('php.requiresPhp');
      const requested = environment.php.requestedVersion.split('.').slice(0, 2).join('.');
      if (observed.php.version.split('.').slice(0, 2).join('.') !== requested) failures.push('php.requestedVersion');
    }
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
  return /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
}

function versionAtLeast(value: string, minimum: string): boolean {
  const left = value.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
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

function proofToolingVersion(name: (typeof PROOF_TOOLING)[number]): string {
  const version = packageJson.devDependencies?.[name];
  if (!version) throw new Error(`Missing pinned proof tooling declaration for ${name}.`);
  return version;
}

function unavailableProofTooling(profile: ProofProfileName): string[] {
  const required = proofToolingForProfile(profile);
  const require = createRequire(import.meta.url);
  const unavailable: string[] = [];
  for (const name of required) {
    const expected = proofToolingVersion(name);
    try {
      const manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version?: unknown };
      if (manifest.version !== expected) {
        unavailable.push(`${name}@${expected} (found ${typeof manifest.version === 'string' ? manifest.version : 'unknown'})`);
      }
    } catch {
      unavailable.push(`${name}@${expected}`);
    }
  }
  return unavailable;
}

function unavailableProofToolingMessage(profile: ProofProfileName, unavailable: readonly string[]): string {
  return [
    `The ${profile} WordPress proof needs optional tooling that is unavailable or not pinned: ${unavailable.join(', ')}.`,
    `Install the exact proof toolchain in this project: ${proofToolingInstallCommand(profile)}`,
    'Then install the browser explicitly: npx --no-install playwright install chromium',
    'A working Docker CLI and daemon are also required for real-WordPress proof. No tooling was downloaded or started.',
  ].join(' ');
}

function unavailableChromiumBrowser(): boolean {
  const require = createRequire(import.meta.url);
  try {
    const playwright = require('@playwright/test') as {
      chromium?: { executablePath?: () => string };
    };
    const executablePath = playwright.chromium?.executablePath?.();
    return !executablePath || !existsSync(executablePath);
  } catch {
    // The package availability preflight reports the exact missing package;
    // retain this conservative result in case this helper is called directly.
    return true;
  }
}

function unavailableChromiumBrowserMessage(): string {
  return [
    'Chromium is not installed for the pinned Playwright proof tooling.',
    'Install it explicitly: npx --no-install playwright install chromium',
    'No browser was downloaded and Docker was not started.',
  ].join(' ');
}

function proofToolingInstallCommand(profile: ProofProfileName): string {
  const required = proofToolingForProfile(profile);
  return required.length === 0 ? 'no optional proof tooling is required for this headless claim' : `npm install --save-dev --save-exact ${required.map((name) => `${name}@${proofToolingVersion(name)}`).join(' ')}`;
}

function proofToolingForProfile(profile: ProofProfileName): readonly (typeof PROOF_TOOLING)[number][] {
  if (profile === 'theme' || profile === 'site') return THEME_PROOF_TOOLING;
  // `runtime` has historically required the browser proof toolchain for its
  // registry observations. Keep that contract for its capability alias `built`.
  if (profile === 'headless' || profile === 'generated') return [];
  if (profile === 'full' || profile === 'fidelity-checked') return PROOF_TOOLING;
  return BROWSER_PROOF_TOOLING;
}

function resolveProjectRoot(modulePath: string): string {
  const moduleDirectory = path.dirname(modulePath);
  for (const candidate of [moduleDirectory, path.dirname(moduleDirectory), path.dirname(path.dirname(moduleDirectory))]) {
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Could not locate block-runner package root from ${modulePath}`);
}
