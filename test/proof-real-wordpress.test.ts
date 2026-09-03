import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROOF_PROFILES, canonicalJson, runProof, type ProofFixture } from '../src/index.js';

const pluginZip = process.env.BLOCK_RUNNER_REAL_PROOF_PLUGIN_ZIP;
const inputPath = process.env.BLOCK_RUNNER_REAL_PROOF_INPUT;
const markupPath = process.env.BLOCK_RUNNER_REAL_PROOF_MARKUP;
const goldenPath = process.env.BLOCK_RUNNER_REAL_PROOF_GOLDEN;
const enabled = Boolean(pluginZip && inputPath && markupPath && goldenPath);

/**
 * This is deliberately an opt-in integration test: it starts Docker/wp-env and
 * produces a complete full-profile receipt from a real generated plugin. It
 * never supplies a proof adapter, so an all-green result is WordPress/browser
 * evidence rather than fabricated headless gate data.
 */
(enabled ? describe : describe.skip)('real WordPress full-profile receipt', () => {
  it('writes one complete, passing WordPress 7.1 receipt', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/proof-pattern-overrides.json', import.meta.url), 'utf8'),
    ) as ProofFixture;
    fixture.visual = {
      ...fixture.visual!,
      expectedPath: path.resolve(goldenPath!),
    };
    expect(existsSync(fixture.visual.expectedPath)).toBe(true);

    const outputDir = await mkdtemp(path.join(tmpdir(), 'block-runner-real-proof-'));
    const result = await runProof({
      profile: 'full',
      pluginZip: path.resolve(pluginZip!),
      inputPath: path.resolve(inputPath!),
      markup: await readFile(path.resolve(markupPath!), 'utf8'),
      fixture,
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
    await expect(readFile(path.join(outputDir, result.receiptReference.path), 'utf8'))
      .resolves.toBe(canonicalJson(result.receipt));
  }, 180_000);
});
