/**
 * The proof ladder is intentionally independent from any particular runner.  A
 * runner may add evidence to a gate record, but this module owns the rules for
 * deciding whether a selected profile actually passed.
 */

/** All statuses which may be written to a receipt gate. */
export const PROOF_GATE_STATUSES = [
  'pass',
  'fail',
  'skip',
  'blocked',
  'not_applicable',
] as const;

export type ProofGateStatus = (typeof PROOF_GATE_STATUSES)[number];

/** Backwards-friendly short aliases for consumers building receipt records. */
export type GateStatus = ProofGateStatus;

/**
 * The canonical gate names used in proof receipts.  Each independent claim has
 * its own gate: for example, PHP registration cannot stand in for the REST or
 * browser registries.
 */
export const PROOF_GATE_IDS = [
  'headless_validation',
  'zip_installation',
  'plugin_activation',
  'php_registry',
  'rest_block_type',
  'client_registry',
  'environment_observation',
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
  'static_deactivation_html',
  'static_deactivation_registration',
  'static_deactivation_assets',
  'static_deactivation_editor_controls',
  'pattern_overrides',
  'visual_regression',
  'accessibility_editor',
  'accessibility_frontend',
  'accessibility_manual_review',
] as const;

export type ProofGateId = (typeof PROOF_GATE_IDS)[number];
export type GateId = ProofGateId;

export const PROOF_PROFILE_NAMES = ['headless', 'runtime', 'editor', 'full'] as const;

export type ProofProfileName = (typeof PROOF_PROFILE_NAMES)[number];
export type ProfileName = ProofProfileName;

/**
 * A single receipt assertion. Evidence is deliberately opaque here so the
 * evaluator remains usable by file, Playwright, and REST-backed runners.
 */
export interface ProofGateRecord {
  /** Canonical gate id, or a documented alias accepted by `normalizeProofGateId`. */
  gate: ProofGateId | string;
  status: ProofGateStatus;
  /** Human-readable reason, especially important for skip and blocked. */
  reason?: string;
  /** Content-addressed evidence references or runner-specific evidence metadata. */
  evidence?: readonly unknown[] | Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  [key: string]: unknown;
}

export type GateRecord = ProofGateRecord;

/** A profile is explicit about every gate needed to make its claim. */
export interface ProofProfile {
  name: ProofProfileName;
  requiredGates: readonly ProofGateId[];
  /** Gates that a runner may record but which do not affect this profile. */
  optionalGates: readonly ProofGateId[];
}

export type ProofGateRecords =
  | readonly ProofGateRecord[]
  | Readonly<Record<string, ProofGateRecord | ProofGateStatus | undefined>>;

export interface ProofGateOutcome {
  gate: ProofGateId;
  status: ProofGateStatus | 'missing';
  ok: boolean;
  record?: ProofGateRecord;
}

/** A pure, serializable result suitable for embedding in an immutable receipt. */
export interface ProofProfileReport {
  profile: ProofProfileName;
  ok: boolean;
  status: 'pass' | 'fail';
  required: readonly ProofGateOutcome[];
  failedGates: readonly ProofGateOutcome[];
  missingGates: readonly ProofGateId[];
}

export type ProofProfileEvaluation = ProofProfileReport;

/**
 * Canonical aliases accepted at the receipt boundary. They let runner code use
 * concise names without weakening the receipt's stable vocabulary.
 */
export const PROOF_GATE_ALIASES: Readonly<Record<string, ProofGateId>> = Object.freeze({
  headless: 'headless_validation',
  validation: 'headless_validation',
  install: 'zip_installation',
  zip_install: 'zip_installation',
  activate: 'plugin_activation',
  activation: 'plugin_activation',
  php: 'php_registry',
  rest: 'rest_block_type',
  rest_registry: 'rest_block_type',
  client: 'client_registry',
  editor_insert: 'editor_inserter',
  inserter: 'editor_inserter',
  editor_edit: 'editor_field_editing',
  editor_fields: 'editor_field_editing',
  edit_fields: 'editor_field_editing',
  save: 'editor_save',
  reopen: 'editor_reopen',
  frontend: 'frontend_status',
  frontend_errors: 'frontend_runtime_errors',
  console: 'frontend_runtime_errors',
  deactivation_html: 'static_deactivation_html',
  deactivation_registration: 'static_deactivation_registration',
  deactivation_assets: 'static_deactivation_assets',
  deactivation_editor_controls: 'static_deactivation_editor_controls',
  static_deactivation: 'static_deactivation_html',
  pattern_override: 'pattern_overrides',
  visual: 'visual_regression',
  axe_editor: 'accessibility_editor',
  axe_frontend: 'accessibility_frontend',
  manual_review: 'accessibility_manual_review',
});

const headlessGates = ['headless_validation'] as const satisfies readonly ProofGateId[];

const runtimeGates = [
  ...headlessGates,
  'zip_installation',
  'plugin_activation',
  'php_registry',
  'rest_block_type',
  'client_registry',
  'environment_observation',
] as const satisfies readonly ProofGateId[];

const editorGates = [
  ...runtimeGates,
  'editor_inserter',
  'editor_field_editing',
  'editor_save',
  'editor_reopen',
] as const satisfies readonly ProofGateId[];

const fullGates = [
  ...editorGates,
  'frontend_status',
  'frontend_semantics',
  'frontend_links',
  'frontend_media',
  'frontend_assets',
  'frontend_runtime_errors',
  'php_logs',
  'static_deactivation_html',
  'static_deactivation_registration',
  'static_deactivation_assets',
  'static_deactivation_editor_controls',
  'pattern_overrides',
  'visual_regression',
  'accessibility_editor',
  'accessibility_frontend',
  'accessibility_manual_review',
] as const satisfies readonly ProofGateId[];

/**
 * The ladder is cumulative. Selecting `editor`, for example, also proves the
 * real-runtime gates on which a useful editor proof relies.
 */
export const PROOF_PROFILES: Readonly<Record<ProofProfileName, ProofProfile>> = Object.freeze({
  headless: Object.freeze({
    name: 'headless',
    requiredGates: headlessGates,
    optionalGates: [],
  }),
  runtime: Object.freeze({
    name: 'runtime',
    requiredGates: runtimeGates,
    optionalGates: [],
  }),
  editor: Object.freeze({
    name: 'editor',
    requiredGates: editorGates,
    optionalGates: [],
  }),
  full: Object.freeze({
    name: 'full',
    requiredGates: fullGates,
    optionalGates: [],
  }),
});

/** Lowercase aliases make programmatic consumption less noisy. */
export const proofProfiles = PROOF_PROFILES;
export const proofGateIds = PROOF_GATE_IDS;
export const proofGateStatuses = PROOF_GATE_STATUSES;

/** Return a profile after validating an untrusted profile name. */
export function getProofProfile(profile: ProofProfileName): ProofProfile {
  return PROOF_PROFILES[profile];
}

/** True only for the five statuses the receipt format permits. */
export function isProofGateStatus(value: unknown): value is ProofGateStatus {
  return typeof value === 'string' && (PROOF_GATE_STATUSES as readonly string[]).includes(value);
}

/** True only for one of the four named proof profiles. */
export function isProofProfileName(value: unknown): value is ProofProfileName {
  return typeof value === 'string' && (PROOF_PROFILE_NAMES as readonly string[]).includes(value);
}

/**
 * Normalize a gate name without accepting arbitrary strings as requirements.
 * Hyphenated aliases are accepted because command-line and JSON inputs often
 * use them, while receipts retain underscore-separated canonical ids.
 */
export function normalizeProofGateId(gate: string): ProofGateId | undefined {
  const candidate = gate.trim().toLowerCase().replace(/-/g, '_');
  if ((PROOF_GATE_IDS as readonly string[]).includes(candidate)) {
    return candidate as ProofGateId;
  }
  return PROOF_GATE_ALIASES[candidate];
}

/**
 * A safe empty set of receipt records. `skip` is intentional: it prevents an
 * accidentally unrun required gate from looking successful while still saying
 * why the profile is incomplete.
 */
export function createDefaultProofGateRecords(
  status: ProofGateStatus = 'skip',
): Record<ProofGateId, ProofGateRecord> {
  return Object.fromEntries(
    PROOF_GATE_IDS.map((gate) => [gate, { gate, status }]),
  ) as Record<ProofGateId, ProofGateRecord>;
}

/** Alias for callers that prefer the shorter receipt terminology. */
export const createDefaultGateRecords = createDefaultProofGateRecords;

/**
 * Evaluate a selected profile without mutating the supplied records. A
 * required gate passes only with `pass`, except for the explicitly
 * input-inapplicable media gate. `not_applicable` is evidence, not a general
 * escape hatch for omitted proof configuration: a missing frontend URL,
 * editable-field inventory, pattern fixture, visual golden, or accessibility
 * scope must block its required gate. `fail`, `skip`, `blocked`, and a missing
 * record always fail the profile.
 */
export function evaluateProofProfile(
  profile: ProofProfileName | ProofProfile,
  records: ProofGateRecords,
): ProofProfileReport {
  const selected = typeof profile === 'string' ? getProofProfile(profile) : profile;
  const byGate = indexProofGateRecords(records);
  const required = selected.requiredGates.map((gate): ProofGateOutcome => {
    const record = byGate.get(gate);
    const status = record?.status ?? 'missing';
    return {
      gate,
      status,
      ok: status === 'pass' || (status === 'not_applicable' && canBeNotApplicable(gate)),
      ...(record ? { record } : {}),
    };
  });
  const failedGates = required.filter((outcome) => !outcome.ok);
  const missingGates = required
    .filter((outcome) => outcome.status === 'missing')
    .map((outcome) => outcome.gate);

  return {
    profile: selected.name,
    ok: failedGates.length === 0,
    status: failedGates.length === 0 ? 'pass' : 'fail',
    required,
    failedGates,
    missingGates,
  };
}

/**
 * Media is the only required claim whose absence can be established from the
 * input itself. Every other profile claim needs affirmative proof.
 */
export function canBeNotApplicable(gate: ProofGateId): boolean {
  return gate === 'frontend_media';
}

/** Alias for the common "profile report" wording used by receipt writers. */
export const evaluateProfile = evaluateProofProfile;
export const reportProofProfile = evaluateProofProfile;

/** Evaluate every profile against the same receipt records. */
export function evaluateProofProfiles(
  records: ProofGateRecords,
): Record<ProofProfileName, ProofProfileReport> {
  return Object.fromEntries(
    PROOF_PROFILE_NAMES.map((profile) => [profile, evaluateProofProfile(profile, records)]),
  ) as Record<ProofProfileName, ProofProfileReport>;
}

/**
 * Index records by canonical gate. Array records later in the array win; this
 * mirrors append-only receipt writers where a retried gate emits a newer entry.
 */
function indexProofGateRecords(records: ProofGateRecords): Map<ProofGateId, ProofGateRecord> {
  const values: ProofGateRecord[] = Array.isArray(records)
    ? [...records]
    : Object.entries(records).flatMap(([key, value]) => {
        if (!value) return [];
        if (typeof value === 'string') return [{ gate: key, status: value }];
        return [{ ...value, gate: value.gate ?? key }];
      });

  const result = new Map<ProofGateId, ProofGateRecord>();
  for (const record of values) {
    const gate = normalizeProofGateId(record.gate);
    if (gate) result.set(gate, record);
  }
  return result;
}
