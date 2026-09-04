import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildPatternOverridesFixture } from '../scripts/build-pattern-overrides-fixture.js';
import {
  PROOF_PROFILES,
  canonicalJson,
  evaluateReleaseAcceptance,
  runProof,
  summarizeReleaseAcceptance,
} from '../src/index.js';
import {
  loadNativeHeadingControlEvidence,
  loadNativeParagraphControlEvidence,
  type NativeHeadingControlEvidence,
  type NativeParagraphControlEvidence,
  type ReleaseAcceptanceOptions,
} from '../src/proof/release-acceptance.js';

const execFileAsync = promisify(execFile);

/**
 * This deliberately runs only through `npm run test:proof:wordpress`, after
 * the ordinary repository checks. It is unskipped there: Docker and a daemon
 * are explicit prerequisites, not optional evidence inputs.
 */
describe('real WordPress generated-pattern full-profile receipt', () => {
  it('writes a complete raw WordPress 7.1 receipt and a separate acceptance assessment', async () => {
    await requireDocker();
    const outputDir = await proofOutputDirectory();
    const built = await buildPatternOverridesFixture(outputDir);

    expect(existsSync(built.pluginZip)).toBe(true);
    expect(built.nativeContainerMarkup).toContain('has-background');
    expect(built.generatedBlockMarkup).toContain(`<!-- wp:${built.fixture.blockName}`);
    expect(built.fixture.patternOverrides?.canonicalContent).toBe(built.generatedBlockMarkup);
    expect(built.fixture.patternOverrides?.canonicalUpdate.content).toContain(`<!-- wp:${built.fixture.blockName}`);

    const result = await runProof({
      profile: 'full',
      pluginZip: built.pluginZip,
      inputPath: built.inputPath,
      markup: built.nativeContainerMarkup,
      fixture: built.fixture,
      outputDir,
    });

    // `runProof` reports the raw profile. A raw upstream editor finding or a
    // pending manual review is deliberately not rewritten as a pass here.
    expect(result.ok).toBe(result.receipt.profile.ok);
    expect(result.receipt.ok).toBe(result.receipt.profile.ok);
    expect(result.receipt.environment.wordpress).toMatchObject({
      requestedVersion: '7.1',
      coreSource: 'WordPress/WordPress#7.1',
    });
    expect(result.receipt.environment.wordpress.version).toMatch(/^7\.1(?:\.\d+)?$/);
    expect(result.receipt.gates).toHaveLength(PROOF_PROFILES.full.requiredGates.length);
    expect(new Set(result.receipt.gates.map((gate) => gate.gate)).size)
      .toBe(PROOF_PROFILES.full.requiredGates.length);
    expect(existsSync(built.fixture.visual!.expectedPath)).toBe(true);

    // Keep the raw receipt and the acceptance decision side by side. The
    // latter may be blocked: this test proves that the result is reported
    // honestly, while the release checker owns the publishable decision.
    const nativeControlEvidence = controlEvidenceFromEnvironment();
    const acceptance = evaluateReleaseAcceptance(result.receipt, nativeControlEvidence);
    const acceptanceSummary = summarizeReleaseAcceptance(acceptance);
    await writeFile(path.join(outputDir, 'acceptance.json'), `${JSON.stringify(acceptanceSummary, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'receipt-index.json'), `${JSON.stringify({
      schemaVersion: 1,
      receipt: result.receiptReference,
      environment: result.receipt.environment,
      acceptance: { path: 'acceptance.json', summary: acceptanceSummary },
    }, null, 2)}\n`, 'utf8');

    // Assert acceptance only after the raw receipt, acceptance summary, and
    // receipt index have been retained. A failed release gate must not discard
    // the evidence needed to diagnose it.
    expect(acceptance.rawProfile).toEqual(result.receipt.profile);
    expect(acceptance.automated.ok).toBe(acceptance.automated.blockers.length === 0);
    expect(acceptance.release.ok).toBe(acceptance.release.blockers.length === 0);
    if (process.env.BLOCK_RUNNER_PROOF_ACCEPTANCE === 'required') {
      expect(acceptance.automated.ok, JSON.stringify(acceptance.automated.blockers, null, 2)).toBe(true);
    }

    const patternGate = result.receipt.gates.find((gate) => gate.gate === 'pattern_overrides');
    expect(patternGate?.details).toMatchObject({
      canonicalWpBlockContent: expect.stringContaining(`<!-- wp:${built.fixture.blockName}`),
      preSaveCoreBlockContent: expect.any(Array),
      reopenedCoreBlockContent: expect.any(Array),
      resetCoreBlockContent: expect.any(Array),
    });
    const lifecycle = patternGate?.details as {
      preSaveCoreBlockContent?: Array<{ content: Record<string, unknown> }>;
      reopenedCoreBlockContent?: Array<{ content: Record<string, unknown> }>;
      edited?: Array<{ ok?: boolean; scope?: { outsideUnchanged?: boolean } }>;
    } | undefined;
    expect(lifecycle?.preSaveCoreBlockContent).toHaveLength(2);
    expect(lifecycle?.reopenedCoreBlockContent).toHaveLength(2);
    expect(lifecycle?.edited).toHaveLength(2);
    expect(lifecycle?.edited?.every((instance) => instance.ok === true && instance.scope?.outsideUnchanged === true)).toBe(true);
    expect(lifecycle?.preSaveCoreBlockContent?.[0]?.content)
      .not.toEqual(lifecycle?.preSaveCoreBlockContent?.[1]?.content);
    await expect(readFile(path.join(outputDir, result.receiptReference.path), 'utf8'))
      .resolves.toBe(canonicalJson(result.receipt));
  }, 480_000);
});

function controlEvidenceFromEnvironment(): ReleaseAcceptanceOptions {
  return {
    nativeHeadingControlEvidence: headingControlEvidenceFromEnvironment(),
    nativeParagraphControlEvidence: paragraphControlEvidenceFromEnvironment(),
  };
}

function headingControlEvidenceFromEnvironment(): NativeHeadingControlEvidence | undefined {
  const sourcePath = process.env.BLOCK_RUNNER_NATIVE_HEADING_CONTROL_EVIDENCE_PATH;
  const sha256 = process.env.BLOCK_RUNNER_NATIVE_HEADING_CONTROL_EVIDENCE_SHA256;
  const wordpressVersion = process.env.BLOCK_RUNNER_NATIVE_HEADING_CONTROL_WORDPRESS_VERSION;
  if (!sourcePath && !sha256 && !wordpressVersion) return undefined;
  if (!sourcePath || !sha256 || !wordpressVersion) {
    throw new Error('native Heading exception requires evidence path, SHA-256, and observed WordPress version');
  }
  return loadNativeHeadingControlEvidence({
    wordpressVersion,
    evidence: { path: path.resolve(sourcePath), sha256: sha256 as `sha256:${string}` },
  });
}

function paragraphControlEvidenceFromEnvironment(): NativeParagraphControlEvidence | undefined {
  const sourcePath = process.env.BLOCK_RUNNER_NATIVE_PARAGRAPH_CONTROL_EVIDENCE_PATH;
  const sha256 = process.env.BLOCK_RUNNER_NATIVE_PARAGRAPH_CONTROL_EVIDENCE_SHA256;
  const wordpressVersion = process.env.BLOCK_RUNNER_NATIVE_PARAGRAPH_CONTROL_WORDPRESS_VERSION;
  if (!sourcePath && !sha256 && !wordpressVersion) return undefined;
  if (!sourcePath || !sha256 || !wordpressVersion) {
    throw new Error('native Paragraph exception requires evidence path, SHA-256, and observed WordPress version');
  }
  return loadNativeParagraphControlEvidence({
    wordpressVersion,
    evidence: { path: path.resolve(sourcePath), sha256: sha256 as `sha256:${string}` },
  });
}

/**
 * CI supplies a retained directory so the receipt and every content-addressed
 * evidence object can be uploaded after this test. Local runs remain isolated
 * in a temporary directory.
 */
async function proofOutputDirectory(): Promise<string> {
  const configured = process.env.BLOCK_RUNNER_PROOF_OUTPUT_DIR;
  if (!configured) return mkdtemp(path.join(tmpdir(), 'block-runner-real-proof-'));
  const outputDir = path.resolve(configured);
  await mkdir(outputDir, { recursive: true });
  return outputDir;
}

async function requireDocker(): Promise<void> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The WordPress 7.1 receipt test requires a working Docker CLI and daemon (docker info): ${message}`);
  }
}
