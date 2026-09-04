import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultProofGateRecords,
  evaluateReleaseAcceptance,
  loadNativeHeadingControlEvidence,
  loadNativeParagraphControlEvidence,
  summarizeReleaseAcceptance,
  type ProofGateRecord,
  type ProofReceiptDocument,
} from '../src/index.js';

function receipt(overrides: Partial<Record<string, ProofGateRecord>> = {}): ProofReceiptDocument {
  const gates = createDefaultProofGateRecords('pass');
  for (const [gate, value] of Object.entries(overrides)) {
    gates[gate as keyof typeof gates] = value!;
  }
  return {
    schemaVersion: 1,
    kind: 'block-runner.wordpress-proof',
    createdAt: '2026-09-04T00:00:00.000Z',
    selectedProfile: 'full',
    ok: false,
    environment: { wordpress: { version: '7.1' } } as ProofReceiptDocument['environment'],
    gates: Object.values(gates),
    profile: {} as ProofReceiptDocument['profile'],
  };
}

const headingNode = {
  html: '<h2 role="document" aria-multiline="true" aria-readonly="false" data-type="core/heading">Heading</h2>',
  target: ['#heading'],
};

const paragraphNode = {
  html: '<p role="document" aria-multiline="true" aria-readonly="false" data-type="core/paragraph">Paragraph</p>',
  target: ['#paragraph'],
};

const nativeHeadingControlEvidence = {
  wordpressVersion: '7.1',
  evidence: {
    path: 'control/evidence/sha256/native-heading-control.json',
    sha256: `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
  },
  controlReceipt: {
    wordpressVersion: '7.1',
    gates: {
      client_registry: { status: 'pass', details: { block: 'core/heading' } },
      editor_inserter: { status: 'pass' },
      editor_field_editing: { status: 'pass' },
      editor_save: { status: 'pass' },
      editor_reopen: { status: 'pass' },
      accessibility_editor: { status: 'fail', details: headingAxe() },
    },
  },
} as const;

const nativeParagraphControlEvidence = {
  wordpressVersion: '7.1',
  evidence: {
    path: 'control/evidence/sha256/native-paragraph-control.json',
    sha256: `sha256:${'c'.repeat(64)}` as `sha256:${string}`,
  },
  controlReceipt: {
    wordpressVersion: '7.1',
    gates: {
      client_registry: { status: 'pass', details: { block: 'core/paragraph' } },
      editor_inserter: { status: 'pass' },
      editor_field_editing: { status: 'pass' },
      editor_save: { status: 'pass' },
      editor_reopen: { status: 'pass' },
      accessibility_editor: { status: 'fail', details: paragraphAxe() },
    },
  },
} as const;

const cleanNativeHeadingControlEvidence = {
  wordpressVersion: '7.1',
  evidence: {
    path: 'control/evidence/sha256/native-heading-control-clean.json',
    sha256: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
  },
  controlReceipt: {
    wordpressVersion: '7.1',
    gates: {
      client_registry: { status: 'pass', details: { block: 'core/heading' } },
      editor_inserter: { status: 'pass' },
      editor_field_editing: { status: 'pass' },
      editor_save: { status: 'pass' },
      editor_reopen: { status: 'pass' },
      accessibility_editor: { status: 'pass', details: { axe: { violations: [] } } },
    },
  },
} as const;

function headingAxe(nodes = [headingNode]) {
  return {
    axe: {
      violations: [
        { id: 'aria-allowed-attr', nodes },
        { id: 'aria-allowed-role', nodes: [headingNode] },
      ],
    },
  };
}

function paragraphAxe(nodes = [paragraphNode]) {
  return {
    axe: {
      violations: [
        { id: 'aria-allowed-attr', nodes },
      ],
    },
  };
}

describe('0.9 proof release acceptance', () => {
  it('loads and validates the hash-bound native control before applying the exception', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-heading-control-'));
    const controlPath = path.join(root, 'native-heading-control.json');
    const controlReceipt = nativeHeadingControlEvidence.controlReceipt;
    const bytes = `${JSON.stringify(controlReceipt)}\n`;
    await writeFile(controlPath, bytes, 'utf8');
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`;

    const loaded = loadNativeHeadingControlEvidence({
      wordpressVersion: '7.1',
      evidence: { path: controlPath, sha256 },
    });

    expect(loaded.controlReceipt).toEqual(controlReceipt);
  });

  it('loads and validates the hash-bound native Paragraph control', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-paragraph-control-'));
    const controlPath = path.join(root, 'native-paragraph-control.json');
    const controlReceipt = nativeParagraphControlEvidence.controlReceipt;
    const bytes = `${JSON.stringify(controlReceipt)}\n`;
    await writeFile(controlPath, bytes, 'utf8');
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`;

    const loaded = loadNativeParagraphControlEvidence({
      wordpressVersion: '7.1',
      evidence: { path: controlPath, sha256 },
    });

    expect(loaded.controlReceipt).toEqual(controlReceipt);
  });

  it('rejects a control file whose declared version is not observed in its payload', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-heading-control-version-'));
    const controlPath = path.join(root, 'native-heading-control.json');
    const { wordpressVersion: _ignored, ...withoutVersion } = nativeHeadingControlEvidence.controlReceipt as Record<string, unknown>;
    const bytes = `${JSON.stringify(withoutVersion)}\n`;
    await writeFile(controlPath, bytes, 'utf8');
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`;

    expect(() => loadNativeHeadingControlEvidence({
      wordpressVersion: '7.1',
      evidence: { path: controlPath, sha256 },
    })).toThrow('observed WordPress version');
  });

  it('loads a clean native control but does not turn it into an exception basis', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-heading-control-clean-'));
    const controlPath = path.join(root, 'native-heading-control.json');
    const controlReceipt = cleanNativeHeadingControlEvidence.controlReceipt;
    const bytes = `${JSON.stringify(controlReceipt)}\n`;
    await writeFile(controlPath, bytes, 'utf8');
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as `sha256:${string}`;
    const loaded = loadNativeHeadingControlEvidence({
      wordpressVersion: '7.1',
      evidence: { path: controlPath, sha256 },
    });

    const result = evaluateReleaseAcceptance(receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        details: headingAxe(),
      },
      accessibility_manual_review: { gate: 'accessibility_manual_review', status: 'pass' },
    }), { nativeHeadingControlEvidence: loaded });

    expect(loaded.controlReceipt).toEqual(controlReceipt);
    expect(result.acceptedUpstreamFindings).toEqual([]);
    expect(result.automated.blockers).toContainEqual(expect.objectContaining({
      gate: 'accessibility_editor',
      reason: expect.stringContaining('control is clean'),
    }));
  });

  it('keeps raw Heading Axe failures while accepting only the approved native nodes for automated CI', () => {
    const result = evaluateReleaseAcceptance(receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        reason: 'Axe found editor subtree violations.',
        details: headingAxe(),
      },
      accessibility_manual_review: {
        gate: 'accessibility_manual_review',
        status: 'blocked',
        reason: 'Manual review has not been supplied.',
      },
    }), { nativeHeadingControlEvidence });

    expect(result.rawProfile.ok).toBe(false);
    expect(result.rawProfile.failedGates.map(({ gate }) => gate)).toEqual([
      'accessibility_editor',
      'accessibility_manual_review',
    ]);
    expect(result.acceptedUpstreamFindings).toHaveLength(2);
    expect(result.automated).toMatchObject({ ok: true, blockers: [] });
    expect(result.release).toMatchObject({ ok: false, status: 'blocked' });
    expect(summarizeReleaseAcceptance(result)).not.toHaveProperty('nativeHeadingControlEvidence.controlReceipt');
    expect(result.release.blockers).toContainEqual(expect.objectContaining({
      gate: 'accessibility_manual_review',
      status: 'blocked',
    }));
  });

  it('keeps raw Paragraph Axe failures while accepting the approved native Paragraph control', () => {
    const result = evaluateReleaseAcceptance(receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        reason: 'Axe found editor subtree violations.',
        details: paragraphAxe(),
      },
      accessibility_manual_review: {
        gate: 'accessibility_manual_review',
        status: 'pass',
      },
    }), { nativeParagraphControlEvidence });

    expect(result.rawProfile.ok).toBe(false);
    expect(result.rawProfile.failedGates.map(({ gate }) => gate)).toContain('accessibility_editor');
    expect(result.acceptedUpstreamFindings).toEqual([expect.objectContaining({
      exceptionId: 'wordpress-7.1-native-paragraph-editor-a11y',
      violationId: 'aria-allowed-attr',
      target: '#paragraph',
    })]);
    expect(result.automated).toMatchObject({ ok: true, blockers: [] });
    expect(result.release).toMatchObject({ ok: true, status: 'passed', blockers: [] });
    expect(summarizeReleaseAcceptance(result)).not.toHaveProperty('nativeParagraphControlEvidence.controlReceipt');
  });

  it('does not let a Paragraph finding hide inside the Heading exception', () => {
    const result = evaluateReleaseAcceptance(receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        details: headingAxe([headingNode, paragraphNode]),
      },
      accessibility_manual_review: { gate: 'accessibility_manual_review', status: 'pass' },
    }), { nativeHeadingControlEvidence });

    expect(result.acceptedUpstreamFindings).toHaveLength(2);
    expect(result.automated.ok).toBe(false);
    expect(result.automated.blockers).toContainEqual(expect.objectContaining({
      gate: 'accessibility_editor',
      status: 'fail',
    }));
    expect(result.release.status).toBe('failed');
  });

  it('rejects an unknown Axe rule even when it points at a native Heading', () => {
    const result = evaluateReleaseAcceptance(receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        details: { axe: { violations: [{ id: 'color-contrast', nodes: [headingNode] }] } },
      },
      accessibility_manual_review: { gate: 'accessibility_manual_review', status: 'pass' },
    }), { nativeHeadingControlEvidence });

    expect(result.acceptedUpstreamFindings).toEqual([]);
    expect(result.automated.ok).toBe(false);
    expect(result.automated.blockers[0]).toMatchObject({
      gate: 'accessibility_editor',
      reason: expect.stringContaining('color-contrast'),
    });
  });

  it('requires the retained control to contain the exact Axe finding being excepted', () => {
    const controlWithOnlyAttr = {
      ...nativeHeadingControlEvidence,
      controlReceipt: {
        ...nativeHeadingControlEvidence.controlReceipt,
        gates: {
          ...nativeHeadingControlEvidence.controlReceipt.gates,
          accessibility_editor: { status: 'fail', details: {
            axe: { violations: [{ id: 'aria-allowed-attr', nodes: [headingNode] }] },
          } },
        },
      },
    };
    const result = evaluateReleaseAcceptance(receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        details: { axe: { violations: [{ id: 'aria-allowed-role', nodes: [headingNode] }] } },
      },
      accessibility_manual_review: { gate: 'accessibility_manual_review', status: 'pass' },
    }), { nativeHeadingControlEvidence: controlWithOnlyAttr });

    expect(result.acceptedUpstreamFindings).toEqual([]);
    expect(result.automated.blockers).toContainEqual(expect.objectContaining({
      gate: 'accessibility_editor',
      reason: expect.stringContaining('does not contain Axe finding aria-allowed-role'),
    }));
  });

  it('can accept a release only after the manual review gate passes', () => {
    const result = evaluateReleaseAcceptance(receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        details: headingAxe(),
      },
      accessibility_manual_review: { gate: 'accessibility_manual_review', status: 'pass' },
    }), { nativeHeadingControlEvidence });

    expect(result.rawProfile.ok).toBe(false);
    expect(result.automated.ok).toBe(true);
    expect(result.release).toMatchObject({ ok: true, status: 'passed', blockers: [] });
  });

  it('does not apply the exception without an observed control evidence reference', () => {
    const result = evaluateReleaseAcceptance(receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        details: headingAxe(),
      },
      accessibility_manual_review: { gate: 'accessibility_manual_review', status: 'pass' },
    }));

    expect(result.acceptedUpstreamFindings).toEqual([]);
    expect(result.automated.blockers).toContainEqual(expect.objectContaining({
      gate: 'accessibility_editor',
      reason: expect.stringContaining('immutable evidence reference/hash'),
    }));
  });

  it('does not apply a control exception when the generated proof observed another WordPress version', () => {
    const candidate = receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        details: headingAxe(),
      },
      accessibility_manual_review: { gate: 'accessibility_manual_review', status: 'pass' },
    });
    candidate.environment.wordpress.version = '7.1.1';

    const result = evaluateReleaseAcceptance(candidate, { nativeHeadingControlEvidence });

    expect(result.acceptedUpstreamFindings).toEqual([]);
    expect(result.automated.blockers).toContainEqual(expect.objectContaining({
      gate: 'accessibility_editor',
      reason: expect.stringContaining('same supported 7.1 version'),
    }));
  });

  it('does not apply a control exception when the generated proof has no observed WordPress version', () => {
    const candidate = receipt({
      accessibility_editor: {
        gate: 'accessibility_editor',
        status: 'fail',
        details: headingAxe(),
      },
      accessibility_manual_review: { gate: 'accessibility_manual_review', status: 'pass' },
    });
    delete (candidate.environment.wordpress as { version?: string }).version;

    const result = evaluateReleaseAcceptance(candidate, { nativeHeadingControlEvidence });

    expect(result.acceptedUpstreamFindings).toEqual([]);
    expect(result.automated.blockers).toContainEqual(expect.objectContaining({
      gate: 'accessibility_editor',
      reason: expect.stringContaining('observed WordPress unavailable'),
    }));
  });
});
