import {
  canBeNotApplicable,
  evaluateProofProfile,
  PROOF_PROFILES,
  type ProofGateId,
  type ProofGateRecord,
  type ProofProfileReport,
} from './profiles.js';
import type { ProofReceiptDocument } from './runner.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * The one upstream exception currently approved for the 0.9 testing release.
 *
 * This is deliberately a node-level exception. It must not turn an entire Axe
 * result, or an arbitrary accessibility failure, into a pass. The matching
 * code below also requires the exact native Heading markup that WordPress 7.1
 * emits, so a Paragraph (or a custom wrapper) remains a release blocker.
 */
export const APPROVED_UPSTREAM_EXCEPTION_ID =
  'wordpress-7.1-native-heading-editor-a11y' as const;

const APPROVED_HEADING_FINDINGS = new Set(['aria-allowed-attr', 'aria-allowed-role']);
const MANUAL_REVIEW_GATE: ProofGateId = 'accessibility_manual_review';

export type ReleaseAcceptanceStatus = 'passed' | 'failed' | 'blocked' | 'engine_error';

export interface ReleaseAcceptanceBlocker {
  gate: ProofGateId | 'receipt';
  status: string;
  reason: string;
}

export interface AcceptedUpstreamFinding {
  exceptionId: typeof APPROVED_UPSTREAM_EXCEPTION_ID;
  gate: 'accessibility_editor';
  violationId: string;
  target: string;
  basis: string;
}

/**
 * An immutable reference to a separately run native WordPress control. The
 * caller must retain the referenced bytes and verify the hash before passing
 * this descriptor to the acceptance function; a path or a version string alone
 * is never enough to activate the exception.
 */
export interface NativeHeadingControlEvidence {
  wordpressVersion: string;
  evidence: {
    path: string;
    sha256: `sha256:${string}`;
  };
  /** Parsed standalone-control result; omitted only before loading the file. */
  controlReceipt?: unknown;
}

export interface ReleaseAcceptanceOptions {
  nativeHeadingControlEvidence?: NativeHeadingControlEvidence;
}

/**
 * Load and validate the separately retained native control before using it as
 * an exception basis. The returned descriptor carries the parsed control only
 * in memory; summaries contain the immutable reference, not the full payload.
 */
export function loadNativeHeadingControlEvidence(
  evidence: NativeHeadingControlEvidence,
): NativeHeadingControlEvidence {
  const file = path.resolve(evidence.evidence.path);
  let bytes: Buffer;
  let controlReceipt: unknown;
  try {
    bytes = readFileSync(file);
    controlReceipt = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Could not read native Heading control evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== evidence.evidence.sha256) {
    throw new Error(`Native Heading control evidence hash mismatch: declared ${evidence.evidence.sha256}, observed ${actual}`);
  }
  const loaded = { ...evidence, controlReceipt };
  const validation = validateNativeHeadingControlEvidence(loaded);
  if (!validation.ok) throw new Error(validation.reason);
  return loaded;
}

export interface ReleaseAcceptanceReport {
  /** The unmodified profile evaluation. Raw failures are never rewritten. */
  rawProfile: ProofProfileReport;
  /** Browser/build/fidelity checks, excluding only human manual review. */
  automated: {
    ok: boolean;
    blockers: readonly ReleaseAcceptanceBlocker[];
  };
  /** The publishable 0.9 claim, including the separately supplied manual review. */
  release: {
    ok: boolean;
    status: ReleaseAcceptanceStatus;
    blockers: readonly ReleaseAcceptanceBlocker[];
  };
  /** Exact raw Axe nodes covered by the approved exception, if any. */
  acceptedUpstreamFindings: readonly AcceptedUpstreamFinding[];
  /** The control descriptor supplied for the exception decision, if any. */
  nativeHeadingControlEvidence?: NativeHeadingControlEvidence;
}

/**
 * Assess the full WordPress proof without mutating its receipt.
 *
 * `automated.ok` is intended for CI and mutation baselines: it requires every
 * automated full-profile gate, but leaves the human manual-review gate for the
 * release assessment. `release.ok` is the actual 0.9 release decision and
 * therefore also requires a validated manual-review pass. Neither assessment
 * converts raw gate statuses in the supplied receipt.
 */
export function evaluateReleaseAcceptance(
  receipt: ProofReceiptDocument,
  options: ReleaseAcceptanceOptions = {},
): ReleaseAcceptanceReport {
  const rawProfile = evaluateProofProfile('full', receipt.gates);
  const indexed = indexRequiredRecords(receipt.gates);
  const records = indexed.records;
  const acceptedUpstreamFindings: AcceptedUpstreamFinding[] = [];
  const automatedBlockers: ReleaseAcceptanceBlocker[] = [];

  for (const gate of indexed.duplicates) {
    automatedBlockers.push({
      gate,
      status: 'engine_error',
      reason: 'Receipt contains duplicate records for a required gate; acceptance cannot choose between them.',
    });
  }

  for (const gate of PROOF_PROFILES.full.requiredGates) {
    if (gate === MANUAL_REVIEW_GATE) continue;
    const record = records.get(gate);
    if (!record) {
      automatedBlockers.push({ gate, status: 'missing', reason: 'Required proof gate is missing.' });
      continue;
    }
    if (record.status === 'pass' || (record.status === 'not_applicable' && canBeNotApplicable(gate))) continue;

    if (gate === 'accessibility_editor' && record.status === 'fail') {
      const inspected = inspectApprovedHeadingException(
        record,
        options.nativeHeadingControlEvidence,
        receipt.environment.wordpress.version,
      );
      acceptedUpstreamFindings.push(...inspected.accepted);
      automatedBlockers.push(...inspected.blockers);
      continue;
    }

    automatedBlockers.push({
      gate,
      status: record.status,
      reason: record.reason ?? `Required ${gate} proof did not pass.`,
    });
  }

  const releaseBlockers = [...automatedBlockers];
  const manual = records.get(MANUAL_REVIEW_GATE);
  if (!manual) {
    releaseBlockers.push({ gate: MANUAL_REVIEW_GATE, status: 'missing', reason: 'Manual accessibility review is missing.' });
  } else if (manual.status !== 'pass') {
    releaseBlockers.push({
      gate: MANUAL_REVIEW_GATE,
      status: manual.status,
      reason: manual.reason ?? 'Manual accessibility review did not pass.',
    });
  }

  return {
    rawProfile,
    automated: {
      ok: automatedBlockers.length === 0,
      blockers: automatedBlockers,
    },
    release: {
      ok: releaseBlockers.length === 0,
      status: statusFor(releaseBlockers),
      blockers: releaseBlockers,
    },
    acceptedUpstreamFindings,
    ...(options.nativeHeadingControlEvidence
      ? { nativeHeadingControlEvidence: options.nativeHeadingControlEvidence }
      : {}),
  };
}

/**
 * Short, receipt-safe JSON for release-check output. The full raw Axe payload
 * remains in the WordPress receipt; this summary keeps the release receipt
 * readable while retaining every decision that affected acceptance.
 */
export function summarizeReleaseAcceptance(report: ReleaseAcceptanceReport): {
  rawProfileOk: boolean;
  automatedOk: boolean;
  releaseOk: boolean;
  releaseStatus: ReleaseAcceptanceStatus;
  rawFailures: readonly string[];
  automatedBlockers: readonly ReleaseAcceptanceBlocker[];
  releaseBlockers: readonly ReleaseAcceptanceBlocker[];
  acceptedUpstreamFindings: readonly AcceptedUpstreamFinding[];
  nativeHeadingControlEvidence?: NativeHeadingControlEvidence;
} {
  return {
    rawProfileOk: report.rawProfile.ok,
    automatedOk: report.automated.ok,
    releaseOk: report.release.ok,
    releaseStatus: report.release.status,
    rawFailures: report.rawProfile.failedGates.map(({ gate, status }) => `${gate}:${status}`),
    automatedBlockers: report.automated.blockers,
    releaseBlockers: report.release.blockers,
    acceptedUpstreamFindings: report.acceptedUpstreamFindings,
    ...(report.nativeHeadingControlEvidence
      ? { nativeHeadingControlEvidence: evidenceReference(report.nativeHeadingControlEvidence) }
      : {}),
  };
}

function evidenceReference(evidence: NativeHeadingControlEvidence): Omit<NativeHeadingControlEvidence, 'controlReceipt'> {
  return {
    wordpressVersion: evidence.wordpressVersion,
    evidence: evidence.evidence,
  };
}

function indexRequiredRecords(records: readonly ProofGateRecord[]): {
  records: Map<ProofGateId, ProofGateRecord>;
  duplicates: ProofGateId[];
} {
  const result = new Map<ProofGateId, ProofGateRecord>();
  const duplicates: ProofGateId[] = [];
  for (const gate of PROOF_PROFILES.full.requiredGates) {
    const matches = records.filter((record) => record.gate === gate);
    // A duplicate is handled as a failed/malformed receipt rather than letting
    // a later record hide an earlier failure. Keep the first record here; the
    // duplicate is surfaced as an engine-error blocker below.
    if (matches.length > 0) result.set(gate, matches[0]!);
    if (matches.length > 1) duplicates.push(gate);
  }
  return { records: result, duplicates };
}

function inspectApprovedHeadingException(
  record: ProofGateRecord,
  controlEvidence: NativeHeadingControlEvidence | undefined,
  candidateWordPressVersion: string | undefined,
): {
  accepted: AcceptedUpstreamFinding[];
  blockers: ReleaseAcceptanceBlocker[];
} {
  const accepted: AcceptedUpstreamFinding[] = [];
  const blockers: ReleaseAcceptanceBlocker[] = [];
  const controlValidation = validateNativeHeadingControlEvidence(controlEvidence);
  if (!controlValidation.ok) {
    return {
      accepted,
      blockers: [{
        gate: 'accessibility_editor',
        status: 'fail',
        reason: controlValidation.reason,
      }],
    };
  }
  if (!controlValidation.exceptionAvailable) {
    return {
      accepted,
      blockers: [{
        gate: 'accessibility_editor',
        status: 'fail',
        reason: 'The retained native Heading control is clean; no upstream accessibility exception applies.',
      }],
    };
  }
  const controlWordPressVersion = controlEvidence?.wordpressVersion;
  if (!isSupportedWordPress71(candidateWordPressVersion)
    || candidateWordPressVersion !== controlWordPressVersion) {
    return {
      accepted,
      blockers: [{
        gate: 'accessibility_editor',
        status: 'fail',
        reason: `The generated proof observed WordPress ${candidateWordPressVersion ?? 'unavailable'}, but the retained native control observed ${controlWordPressVersion ?? 'unavailable'}; the exception requires the same supported 7.1 version.`,
      }],
    };
  }
  const axe = asRecord(record.details)?.axe;
  const violations = asRecord(axe)?.violations;
  if (!Array.isArray(violations) || violations.length === 0) {
    return {
      accepted,
      blockers: [{ gate: 'accessibility_editor', status: 'fail', reason: 'Axe failure has no retained violation details to adjudicate.' }],
    };
  }

  for (const violation of violations) {
    const value = asRecord(violation);
    const id = typeof value?.id === 'string' ? value.id : '';
    const nodes = Array.isArray(value?.nodes) ? value.nodes : [];
    if (!APPROVED_HEADING_FINDINGS.has(id) || nodes.length === 0) {
      blockers.push({
        gate: 'accessibility_editor',
        status: 'fail',
        reason: id
          ? `Axe editor finding ${id} is not covered by the approved native Heading exception.`
          : 'Axe editor failure contains an unidentified violation.',
      });
      continue;
    }
    for (const node of nodes) {
      const target = targetFor(node);
      if (isApprovedNativeHeadingNode(node)) {
        accepted.push({
          exceptionId: APPROVED_UPSTREAM_EXCEPTION_ID,
          gate: 'accessibility_editor',
          violationId: id,
          target,
          basis: 'WordPress 7.1 native core/heading h2 editor control emits the same ARIA attributes as the retained standalone control.',
        });
      } else {
        blockers.push({
          gate: 'accessibility_editor',
          status: 'fail',
          reason: `Axe editor finding ${id} includes an unapproved node${target ? ` (${target})` : ''}; only the native WordPress Heading control is excepted.`,
        });
      }
    }
  }
  return { accepted, blockers };
}

function isSupportedWordPress71(version: string | undefined): boolean {
  return typeof version === 'string' && /^7\.1(?:\.\d+)?$/.test(version);
}

function validateNativeHeadingControlEvidence(
  evidence: NativeHeadingControlEvidence | undefined,
): { ok: true; exceptionAvailable: boolean } | { ok: false; reason: string } {
  if (!evidence
    || !/^7\.1(?:\.\d+)?$/.test(evidence.wordpressVersion)
    || typeof evidence.evidence.path !== 'string'
    || evidence.evidence.path.trim().length === 0
    || !/^sha256:[0-9a-f]{64}$/.test(evidence.evidence.sha256)) {
    return { ok: false, reason: 'The native Heading exception requires an observed WordPress 7.1 control and an immutable evidence reference/hash.' };
  }
  if (evidence.controlReceipt === undefined) {
    return { ok: false, reason: 'The native Heading exception requires the retained control result to be loaded and validated.' };
  }
  const control = asRecord(evidence.controlReceipt);
  const observedVersion = observedWordPressVersion(control);
  if (observedVersion !== evidence.wordpressVersion) {
    return {
      ok: false,
      reason: 'Native Heading control evidence must carry an observed WordPress version matching the declared 7.1 version.',
    };
  }
  const gates = asGateMap(control?.gates);
  if (!gates) return { ok: false, reason: 'Native Heading control evidence has no readable gate results.' };
  const required = ['editor_inserter', 'editor_field_editing', 'editor_save', 'editor_reopen'];
  if (required.some((gate) => gates[gate]?.status !== 'pass')) {
    return { ok: false, reason: 'Native Heading control evidence must pass insert, edit, save, and reopen.' };
  }
  const registry = gates.client_registry;
  if (!registry || registry.status !== 'pass' || asRecord(registry.details)?.block !== 'core/heading') {
    return { ok: false, reason: 'Native Heading control evidence must identify a passing standalone core/heading control.' };
  }
  const axe = asRecord(asRecord(gates.accessibility_editor?.details)?.axe);
  const violations = axe?.violations;
  if (gates.accessibility_editor?.status === 'pass'
    && Array.isArray(violations)
    && violations.length === 0) {
    // A future WordPress release may fix the native issue. Keep the clean
    // control as valid lifecycle evidence, but do not use it to adjudicate a
    // generated-block failure: there is no upstream failure to except.
    return { ok: true, exceptionAvailable: false };
  }
  if (gates.accessibility_editor?.status !== 'fail' || !Array.isArray(violations) || violations.length === 0) {
    return { ok: false, reason: 'Native Heading control evidence must retain the expected Axe failure details.' };
  }
  for (const violation of violations) {
    const value = asRecord(violation);
    const id = typeof value?.id === 'string' ? value.id : '';
    const nodes = Array.isArray(value?.nodes) ? value.nodes : [];
    if (!APPROVED_HEADING_FINDINGS.has(id) || nodes.length === 0 || nodes.some((node) => !isApprovedNativeHeadingNode(node))) {
      return { ok: false, reason: 'Native Heading control evidence contains an unexpected Axe rule or non-Heading node.' };
    }
  }
  return { ok: true, exceptionAvailable: true };
}

function observedWordPressVersion(control: Record<string, unknown> | undefined): string | undefined {
  if (!control) return undefined;
  if (typeof control.wordpressVersion === 'string') return control.wordpressVersion;
  const environment = asRecord(control.environment);
  if (typeof environment?.wordpressVersion === 'string') return environment.wordpressVersion;
  const wordpress = asRecord(environment?.wordpress);
  return typeof wordpress?.version === 'string' ? wordpress.version : undefined;
}

function asGateMap(value: unknown): Record<string, Record<string, unknown>> | undefined {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((item) => {
      const record = asRecord(item);
      return typeof record?.gate === 'string' ? [[record.gate, record]] : [];
    }));
  }
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).flatMap(([key, item]) => {
    const gate = asRecord(item);
    return gate ? [[key, gate]] : [];
  }));
}

function isApprovedNativeHeadingNode(node: unknown): boolean {
  const value = asRecord(node);
  const html = typeof value?.html === 'string' ? value.html : '';
  const target = targetFor(node);
  return /^<h2\b/i.test(html)
    && /\brole=["']document["']/.test(html)
    && /\baria-multiline=["']true["']/.test(html)
    && /\baria-readonly=["']false["']/.test(html)
    && /\bdata-type=["']core\/heading["']/.test(html)
    && target.length > 0;
}

function targetFor(node: unknown): string {
  const target = asRecord(node)?.target;
  return Array.isArray(target) ? target.filter((value): value is string => typeof value === 'string').join(' ') : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function statusFor(blockers: readonly ReleaseAcceptanceBlocker[]): ReleaseAcceptanceStatus {
  if (blockers.some(({ status }) => status === 'engine_error')) return 'engine_error';
  if (blockers.some(({ status }) => status === 'fail')) return 'failed';
  if (blockers.some(({ status }) => status === 'blocked' || status === 'skip' || status === 'missing')) return 'blocked';
  return 'passed';
}
