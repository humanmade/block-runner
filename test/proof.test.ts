import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvidenceStore,
  ReceiptWriter,
  createDefaultProofGateRecords,
  evaluateProofProfile,
  runProof,
  reportProofRequirements,
  type ProofGateContext,
} from '../src/index.js';
import { PROOF_GATE_IDS, PROOF_PROFILES, type ProofGateId } from '../src/proof/profiles.js';

describe('WordPress proof profiles', () => {
  it('fails closed when a required gate is skipped or blocked', () => {
    const skipped = createDefaultProofGateRecords('pass');
    skipped.client_registry.status = 'skip';
    const blocked = createDefaultProofGateRecords('pass');
    blocked.editor_save.status = 'blocked';

    expect(evaluateProofProfile('runtime', skipped)).toMatchObject({
      ok: false,
      failedGates: [{ gate: 'client_registry', status: 'skip' }],
    });
    expect(evaluateProofProfile('editor', blocked)).toMatchObject({
      ok: false,
      failedGates: [{ gate: 'editor_save', status: 'blocked' }],
    });
  });

  it('allows not_applicable only for genuinely media-inapplicable assertions', () => {
    const gates = createDefaultProofGateRecords('pass');
    gates.frontend_media.status = 'not_applicable';
    expect(evaluateProofProfile('full', gates).ok).toBe(true);
    gates.visual_regression.status = 'not_applicable';
    expect(evaluateProofProfile('full', gates).ok).toBe(false);
    gates.visual_regression.status = 'pass';
    gates.frontend_media.status = 'skip';
    expect(evaluateProofProfile('full', gates).ok).toBe(false);
  });
});

describe('capability-aware proof requirements', () => {
  const hash = (value: string): `sha256:${string}` => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  it.each([undefined, null, {}, 'bindings'])('reports invalid requiredBindings %j without short-circuit masking', (requiredBindings) => {
    const fixture = { blockName: 'acme/proof', editableFields: [{ path: 'copy', surface: 'richText' }],
      patternOverrides: { title: 'Pattern', canonicalContent: 'canonical', instances: [{}, {}],
        canonicalUpdate: { content: 'updated' }, reset: { instance: 0 }, requiredBindings,
        negative: { value: 'wrong', fallback: 'right' }, structuralPolicy: 'contentOnly' } };
    const result = reportProofRequirements('pattern-verified',
      { sha256: hash('plugin'), capabilities: { patternOverrides: true } }, hash('plugin'),
      fixture as unknown as Parameters<typeof reportProofRequirements>[3]);
    expect(result.missingInputs).toContain('Pattern verification requires the complete two-instance lifecycle fixture.');
  });

  it('derives editor and fidelity claims from a ZIP-bound non-pattern artifact without inventing pattern proof', () => {
    const report = reportProofRequirements(
      'fidelity-checked',
      { sha256: hash('plugin'), capabilities: { patternOverrides: false } },
      hash('plugin'),
      {
        blockName: 'acme/proof',
        editableFields: [{ path: 'content', surface: 'richText' }],
        frontend: { url: 'http://example.test/' },
        visual: { expectedPath: 'golden.png', threshold: 0 },
        accessibility: { manualReview: 'blocked' },
      },
    );
    expect(report.artifact).toMatchObject({ status: 'confirmed', capabilities: { patternOverrides: false } });
    expect(report.requiredGates).toContain('visual_regression');
    expect(report.requiredGates).not.toContain('pattern_overrides');
    expect(report.claims).toEqual([expect.objectContaining({ claim: 'fidelity-checked', status: 'required' })]);
    expect(report.missingInputs).toEqual([]);
  });

  it('requires the real pattern lifecycle when the confirmed artifact declares overrides', () => {
    const report = reportProofRequirements(
      'editor-verified',
      { sha256: hash('plugin'), capabilities: { patternOverrides: true } },
      hash('plugin'),
      { blockName: 'acme/proof', editableFields: [{ path: 'content', surface: 'richText' }] },
    );
    expect(report.requiredGates).toContain('pattern_overrides');
    expect(report.claims).toContainEqual(expect.objectContaining({ claim: 'pattern-verified', status: 'blocked' }));
    expect(report.missingInputs).toContain('Pattern verification requires the complete two-instance lifecycle fixture.');
  });

  it('blocks malformed artifact capabilities at the runner boundary without treating them as false', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-malformed-artifact-'));
    const input = path.join(root, 'input.json');
    const plugin = path.join(root, 'plugin.zip');
    await Promise.all([writeFile(input, '{}'), writeFile(plugin, 'plugin')]);
    const result = await runProof({
      profile: 'generated', inputPath: input, pluginZip: plugin, outputDir: root,
      artifact: { sha256: hash('plugin'), capabilities: {} } as unknown as { sha256: `sha256:${string}`; capabilities: { patternOverrides: boolean } },
      gateRunner: async () => ({ status: 'pass' as const }),
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.requirements?.artifact.status).toBe('invalid');
    expect(result.receipt.requirements?.missingInputs[0]).toContain('well-formed confirmed artifact contract');
    expect(result.receipt.gates[0]).toMatchObject({ status: 'blocked' });
  });

  it('lets a hash-matched override artifact reach the real pattern lifecycle gate', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-pattern-artifact-'));
    const input = path.join(root, 'input.json');
    const plugin = path.join(root, 'plugin.zip');
    await Promise.all([writeFile(input, '{}'), writeFile(plugin, 'plugin')]);
    const content = '<!-- wp:acme/proof --><!-- wp:paragraph {"metadata":{"name":"copy","bindings":{"content":{"source":"core/pattern-overrides"}}}} --><p>Canonical</p><!-- /wp:paragraph --><!-- /wp:acme/proof -->';
    const seen: string[] = [];
    const result = await runProof({
      profile: 'pattern-verified', inputPath: input, pluginZip: plugin, outputDir: root,
      artifact: { sha256: hash('plugin'), capabilities: { patternOverrides: true } },
      fixture: {
        blockName: 'acme/proof', editableFields: [{ path: 'copy', surface: 'richText' }],
        patternOverrides: {
          title: 'Pattern', canonicalContent: content,
          instances: [{ label: 'one', content: { copy: { content: 'One' } } }, { label: 'two', content: { copy: { content: 'Two' } } }],
          canonicalUpdate: { content, marker: 'Canonical' },
          reset: { instance: 0, name: 'copy', attribute: 'content', fallback: 'Canonical' },
          requiredBindings: [{ name: 'copy', attribute: 'content' }], structuralPolicy: 'contentOnly',
          negative: { name: 'copy', attribute: 'content', value: 'Rejected', fallback: 'Canonical' },
        },
      },
      gateRunner: async ({ gate }) => { seen.push(gate); return { status: 'pass' as const }; },
    });
    expect(result.receipt.requirements?.missingInputs).toEqual([]);
    expect(seen).toContain('pattern_overrides');
    expect(result.receipt.gates.find((gate) => gate.gate === 'pattern_overrides')).toMatchObject({ status: 'pass' });
  });

  it('fails closed for null artifact contracts and incomplete pattern fixture JSON', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-null-contract-'));
    const input = path.join(root, 'input.json');
    const plugin = path.join(root, 'plugin.zip');
    await Promise.all([writeFile(input, '{}'), writeFile(plugin, 'plugin')]);
    const nullArtifact = await runProof({
      profile: 'generated', inputPath: input, pluginZip: plugin, outputDir: root,
      artifact: null as unknown as { sha256: `sha256:${string}`; capabilities: { patternOverrides: boolean } },
      gateRunner: async () => ({ status: 'pass' as const }),
    });
    expect(nullArtifact.receipt.requirements?.artifact.status).toBe('missing');
    expect(nullArtifact.receipt.gates[0]).toMatchObject({ status: 'blocked' });

    const incompletePattern = await runProof({
      profile: 'pattern-verified', inputPath: input, pluginZip: plugin, outputDir: path.join(root, 'incomplete'),
      artifact: { sha256: hash('plugin'), capabilities: { patternOverrides: true } },
      fixture: {
        blockName: 'acme/proof', editableFields: [{ path: 'copy', surface: 'richText' }],
        patternOverrides: { title: 'Incomplete', canonicalContent: '', instances: [] as unknown as [never, never], canonicalUpdate: { content: '', marker: '' },
          reset: { instance: 0, name: 'copy', attribute: 'content', fallback: '' }, requiredBindings: undefined as unknown as [], structuralPolicy: 'contentOnly',
          negative: { name: 'copy', attribute: 'content', value: '', fallback: '' } },
      },
      gateRunner: async () => ({ status: 'pass' as const }),
    });
    expect(incompletePattern.receipt.requirements?.missingInputs).toContain('Pattern verification requires the complete two-instance lifecycle fixture.');
    expect(incompletePattern.receipt.gates.find((gate) => gate.gate === 'pattern_overrides')).toMatchObject({ status: 'blocked' });
  });

  it('retains a stale artifact hash as a blocked pre-run input instead of passing an adapter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-stale-artifact-'));
    const input = path.join(root, 'input.json');
    const plugin = path.join(root, 'plugin.zip');
    await Promise.all([writeFile(input, '{}'), writeFile(plugin, 'actual plugin')]);
    const result = await runProof({
      profile: 'generated', inputPath: input, pluginZip: plugin, outputDir: root,
      artifact: { sha256: hash('different plugin'), capabilities: { patternOverrides: false } },
      gateRunner: async () => ({ status: 'pass' as const }),
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.requirements?.missingInputs).toContain('Confirmed artifact SHA-256 does not match the supplied plugin ZIP.');
    expect(result.receipt.gates[0]).toMatchObject({ status: 'blocked' });
  });
});

describe('content-addressed proof receipts', () => {
  it('requires retained input/ZIP-bound evidence for a manual accessibility pass', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-manual-proof-'));
    const input = path.join(root, 'input.json');
    const zip = path.join(root, 'plugin.zip');
    const reviewPath = path.join(root, 'review.json');
    await writeFile(input, 'input');
    await writeFile(zip, 'zip');
    const options = {
      profile: 'full' as const, inputPath: input, pluginZip: zip, outputDir: root,
      fixture: { blockName: 'acme/proof', accessibility: { manualReview: 'pass' as const, manualReviewPath: reviewPath } },
      gateRunner: async () => ({ status: 'pass' as const }),
    };
    const missing = await runProof(options);
    expect(missing.receipt.gates.find((gate) => gate.gate === 'accessibility_manual_review')?.status).toBe('blocked');
    const hash = (value: string): `sha256:${string}` => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    await writeFile(reviewPath, JSON.stringify({
      schemaVersion: 1, reviewer: 'Fixture reviewer', reviewedAt: '2026-09-04T00:00:00Z',
      inputHash: hash('input'), pluginZipHash: hash('zip'), status: 'pass', findings: [],
      checks: { 'editor-keyboard': 'Recorded editor interaction.', 'frontend-keyboard': 'Recorded link focus.', 'focus-visibility': 'Recorded focus indicator.', 'content-reading-order': 'Recorded reading order.' },
    }));
    const recorded = await runProof(options);
    const manual = recorded.receipt.gates.find((gate) => gate.gate === 'accessibility_manual_review');
    expect(manual?.status).toBe('pass');
    expect(manual?.evidence?.length).toBeGreaterThan(0);
    await writeFile(zip, 'different zip');
    const stale = await runProof(options);
    expect(stale.receipt.gates.find((gate) => gate.gate === 'accessibility_manual_review')?.status).toBe('blocked');
  });

  it('stores canonical evidence and receipt bytes at immutable SHA-256 addresses', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-store-'));
    const evidence = new EvidenceStore(root);
    const first = await evidence.putJson({ zebra: 1, alpha: ['x'] });
    const second = await evidence.put('{"alpha":["x"],"zebra":1}', { mediaType: 'application/json' });
    const writer = new ReceiptWriter(root);
    const receipt = await writer.write({ schemaVersion: 1, evidence: first });

    expect(first.sha256).toBe(second.sha256);
    expect(await evidence.read(first)).toEqual(Buffer.from('{"alpha":["x"],"zebra":1}'));
    expect(receipt.path).toMatch(/^receipts\/sha256\/[a-f0-9]{64}\.json$/);
    expect((await writer.read(receipt.sha256)).evidence).toEqual(first);
  });

  it('blocks a full proof when a required proof fixture is absent even if an adapter reports pass', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-receipt-'));
    const input = path.join(root, 'input.html');
    await writeFile(input, '<p>proof input</p>');
    const result = await runProof({
      profile: 'full',
      outputDir: root,
      inputPath: input,
      fixture: { blockName: 'acme/proof' },
      gateRunner: async () => ({ status: 'pass' }),
    });

    expect(result.ok).toBe(false);
    expect(result.profile.failedGates.map((gate) => gate.gate)).toContain('editor_field_editing');
    expect(result.profile.failedGates.map((gate) => gate.gate)).toContain('frontend_status');
    expect(result.profile.failedGates.map((gate) => gate.gate)).toContain('pattern_overrides');
    expect(result.profile.failedGates.map((gate) => gate.gate)).toContain('visual_regression');
    expect(result.profile.failedGates.map((gate) => gate.gate)).toContain('accessibility_editor');
    expect(result.receipt.environment).toMatchObject({
      generator: { package: 'block-runner' },
      plugin: { slug: 'proof' },
      wordpress: { requestedVersion: '7.1' },
      php: { version: expect.any(String) },
      database: { engine: 'mysql' },
      theme: { name: expect.any(String) },
      browser: { engine: 'chromium' },
      node: { version: process.version },
    });
    expect(result.receiptReference.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(path.join(root, result.receiptReference.path), 'utf8'))).toEqual(result.receipt);
  });

  it('keeps full unchanged while exposing capability-specific proof claims', () => {
    expect(PROOF_PROFILES.full.requiredGates).toContain('accessibility_manual_review');
    expect(PROOF_PROFILES['editor-verified'].requiredGates).not.toContain('pattern_overrides');
    expect(PROOF_PROFILES['fidelity-checked'].requiredGates).toContain('visual_regression');
    expect(PROOF_PROFILES['fidelity-checked'].requiredGates).not.toContain('accessibility_manual_review');
    expect(PROOF_PROFILES['pattern-verified'].requiredGates).toContain('pattern_overrides');
  });

  it('does not accidentally leave a required gate absent from a successful profile', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-missing-'));
    const input = path.join(root, 'input.html');
    const pluginZip = path.join(root, 'proof.zip');
    await Promise.all([writeFile(input, '<p>proof input</p>'), writeFile(pluginZip, 'not-a-real-zip')]);
    const records = new Set<ProofGateId>();
    const result = await runProof({
      profile: 'editor',
      outputDir: root,
      inputPath: input,
      pluginZip,
      fixture: {
        blockName: 'acme/proof',
        editableFields: [{ path: 'content', surface: 'richText', value: 'proof' }],
      },
      gateRunner: async ({ gate, environment }) => {
        records.add(gate);
        Object.assign(environment.plugin, { slug: 'proof', name: 'Proof', version: '1.0.0', file: 'proof.php' });
        Object.assign(environment.wordpress, { version: '7.1', coreHash: 'sha256:core', dockerImage: 'sha256:wordpress' });
        Object.assign(environment.php, { version: '8.3' });
        Object.assign(environment.database, { image: 'sha256:mysql', version: '11.0' });
        Object.assign(environment.theme, { name: 'twentytwentyfive', version: '1.0', fileHash: 'sha256:theme' });
        Object.assign(environment.browser, { version: '143.0', revision: '1234' });
        return gate === 'editor_field_editing' ? undefined : { status: 'pass' };
      },
    });

    expect(records).toEqual(new Set(PROOF_GATE_IDS.slice(0, 11)));
    expect(result.ok).toBe(false);
    expect(result.profile.failedGates).toContainEqual(expect.objectContaining({
      gate: 'editor_field_editing',
      status: 'blocked',
    }));
  });

  it('requires retained, successful, parseable observation evidence and locked WordPress package pins', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-proof-observations-'));
    const input = path.join(root, 'input.html');
    const pluginZip = path.join(root, 'proof.zip');
    await Promise.all([writeFile(input, '<p>proof input</p>'), writeFile(pluginZip, 'not-a-real-zip')]);

    const verified = await runProof({
      profile: 'runtime',
      outputDir: root,
      inputPath: input,
      pluginZip,
      fixture: { blockName: 'acme/proof' },
      gateRunner: verifiedRuntimeGateRunner(),
    });
    const observationGate = verified.receipt.gates.find((record) => record.gate === 'environment_observation');
    expect(verified.ok).toBe(true);
    expect(observationGate).toMatchObject({ status: 'pass' });
    expect(observationGate?.evidence).toContainEqual(verified.receipt.environment.observations);

    const cases: Array<[string, (context: ProofGateContext, observations: Record<string, unknown>) => boolean | void, string]> = [
      ['missing raw observation evidence', () => false, 'environment.observations'],
      ['failed PHP observation command', (_context, observations) => {
        (observations.php as { exitCode: number }).exitCode = 1;
      }, 'observations.php.exitCode'],
      ['malformed core hash', (_context, observations) => {
        (observations.coreHash as { stdout: string }).stdout = 'not-a-sha256';
      }, 'observations.coreHash.value'],
      ['missing locked WordPress package', (context) => {
        delete context.environment.wordpressPackages['@wordpress/env'];
      }, 'wordpressPackages.@wordpress/env'],
    ];

    for (const [name, mutate, expectedFailure] of cases) {
      const receiptDir = path.join(root, name.replace(/\W+/g, '-'));
      const result = await runProof({
        profile: 'runtime',
        outputDir: receiptDir,
        inputPath: input,
        pluginZip,
        fixture: { blockName: 'acme/proof' },
        gateRunner: verifiedRuntimeGateRunner(mutate),
      });
      const gate = result.receipt.gates.find((record) => record.gate === 'environment_observation');
      expect(result.ok).toBe(false);
      expect(gate).toMatchObject({ status: 'blocked' });
      const evidence = Array.isArray(gate?.evidence) ? gate.evidence : [];
      const details = await Promise.all(evidence.map(async (reference: unknown): Promise<{ unobserved?: string[] } | undefined> => {
        const candidate = reference as { path: string; mediaType?: string };
        if (candidate.mediaType !== 'application/json') return undefined;
        return JSON.parse(await readFile(path.join(receiptDir, candidate.path), 'utf8')) as { unobserved?: string[] };
      }));
      const detail = details.find((candidate): candidate is { unobserved?: string[] } => Array.isArray(candidate?.unobserved)) ?? {};
      expect(detail.unobserved, name).toContain(expectedFailure);
    }
  });
});

const observationHash = (hex: string): `sha256:${string}` => `sha256:${hex.repeat(64)}`;

function verifiedRuntimeGateRunner(
  mutate?: (context: ProofGateContext, observations: Record<string, unknown>) => boolean | void,
) {
  return async (context: ProofGateContext) => {
    const { environment } = context;
    Object.assign(environment.plugin, { slug: 'proof', name: 'Proof', version: '1.0.0', file: 'proof.php' });
    Object.assign(environment.wordpress, {
      version: '7.1',
      coreHash: observationHash('c'),
      dockerImage: observationHash('a'),
    });
    Object.assign(environment.php, { version: '8.3.1' });
    Object.assign(environment.database, { image: observationHash('b'), version: '11.0.2' });
    Object.assign(environment.theme, { name: 'twentytwentyfive', version: '1.0', fileHash: observationHash('d') });
    Object.assign(environment.browser, { version: '143.0.7499.192', revision: '1234' });

    if (context.gate === 'environment_observation') {
      const observations: Record<string, unknown> = {
        php: successfulCommand('8.3.1'),
        database: successfulCommand('11.0.2'),
        theme: successfulCommand('[{"name":"twentytwentyfive","version":"1.0"}]'),
        themeHash: successfulCommand('d'.repeat(64)),
        wordpress: successfulCommand('7.1'),
        coreHash: successfulCommand('c'.repeat(64)),
        wordpressContainer: successfulCommand('abcdef123456'),
        databaseContainer: successfulCommand('abcdef123456'),
        wordpressImage: successfulCommand(`abcdef123456 ${observationHash('a')} wordpress:7.1`),
        databaseImage: successfulCommand(`abcdef123456 ${observationHash('b')} mysql:8`),
      };
      if (mutate?.(context, observations) !== false) {
        environment.observations = await context.capture(observations);
      }
    }
    return { status: 'pass' as const };
  };
}

function successfulCommand(stdout: string) {
  return { command: 'proof-observation', args: [], exitCode: 0, stdout, stderr: '' };
}
