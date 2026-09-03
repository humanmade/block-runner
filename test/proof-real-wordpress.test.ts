import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildPatternOverridesFixture } from '../scripts/build-pattern-overrides-fixture.js';
import { PROOF_PROFILES, canonicalJson, runProof } from '../src/index.js';

const execFileAsync = promisify(execFile);

/**
 * This deliberately runs only through `npm run test:proof:wordpress`, after
 * the ordinary repository checks. It is unskipped there: Docker and a daemon
 * are explicit prerequisites, not optional evidence inputs.
 */
describe('real WordPress generated-pattern full-profile receipt', () => {
  it('writes a complete WordPress 7.1 receipt for the actual generated block inside a synced pattern', async () => {
    await requireDocker();
    const outputDir = await mkdtemp(path.join(tmpdir(), 'block-runner-real-proof-'));
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

    expect(result.ok).toBe(true);
    expect(result.receipt.environment.wordpress).toMatchObject({
      requestedVersion: '7.1',
      coreSource: 'WordPress/WordPress#7.1',
    });
    expect(result.receipt.environment.wordpress.version).toMatch(/^7\.1(?:\.\d+)?$/);
    expect(result.receipt.gates).toHaveLength(PROOF_PROFILES.full.requiredGates.length);
    expect(result.receipt.gates.every((gate) => gate.status === 'pass')).toBe(true);
    expect(existsSync(built.fixture.visual!.expectedPath)).toBe(true);

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
    } | undefined;
    expect(lifecycle?.preSaveCoreBlockContent).toHaveLength(2);
    expect(lifecycle?.reopenedCoreBlockContent).toHaveLength(2);
    expect(lifecycle?.preSaveCoreBlockContent?.[0]?.content)
      .not.toEqual(lifecycle?.preSaveCoreBlockContent?.[1]?.content);
    await expect(readFile(path.join(outputDir, result.receiptReference.path), 'utf8'))
      .resolves.toBe(canonicalJson(result.receipt));
  }, 480_000);
});

async function requireDocker(): Promise<void> {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The WordPress 7.1 receipt test requires a working Docker CLI and daemon (docker info): ${message}`);
  }
}
