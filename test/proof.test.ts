import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvidenceStore,
  ReceiptWriter,
  createDefaultProofGateRecords,
  evaluateProofProfile,
  runProof,
} from '../src/index.js';
import { PROOF_GATE_IDS, type ProofGateId } from '../src/proof/profiles.js';

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

describe('content-addressed proof receipts', () => {
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
    expect(result.profile.failedGates).toMatchObject([{ gate: 'editor_field_editing', status: 'blocked' }]);
  });
});
