import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPatternOverridesFixture, type BuiltPatternOverridesFixture } from '../scripts/build-pattern-overrides-fixture.js';
import { runProof, type ProofGateId, type ProofRunResult } from '../src/index.js';
import { npmEnvironmentForGeneratedPlugin } from '../src/plugin/profile.js';
import {
  evaluateReleaseAcceptance,
  loadNativeHeadingControlEvidence,
  loadNativeParagraphControlEvidence,
  summarizeReleaseAcceptance,
  type NativeHeadingControlEvidence,
  type NativeParagraphControlEvidence,
} from '../src/proof/release-acceptance.js';

const execFile = promisify(execFileCallback);
const enabled = process.env.BLOCK_RUNNER_PROOF_MUTATIONS === '1';

/**
 * Build the actual CLI output once. Every automated baseline gate must pass
 * acceptance before a mutation can count as a detector test. Manual review is
 * a separate release requirement; accepted upstream findings retain raw failures.
 * Keep the archives, complete
 * status matrix, and failed-run evidence; never delete the only receipt.
 */
(enabled ? describe.sequential : describe.skip)('real WordPress proof mutations', () => {
  let root: string;
  let built: BuiltPatternOverridesFixture;
  let baseline: ProofRunResult;
  let nativeHeadingControlEvidence: NativeHeadingControlEvidence | undefined;
  let nativeParagraphControlEvidence: NativeParagraphControlEvidence | undefined;
  beforeAll(async () => {
    const parent = process.env.BLOCK_RUNNER_PROOF_OUTPUT_DIR ?? tmpdir();
    await mkdir(parent, { recursive: true });
    root = await mkdtemp(path.join(parent, 'block-runner-mutations-'));
    built = await buildPatternOverridesFixture(root);
    const baselineZip = path.join(root, 'baseline.zip');
    await copyFile(built.pluginZip, baselineZip);
    const controlPath = process.env.BLOCK_RUNNER_NATIVE_HEADING_CONTROL_EVIDENCE_PATH;
    const controlHash = process.env.BLOCK_RUNNER_NATIVE_HEADING_CONTROL_EVIDENCE_SHA256;
    const controlVersion = process.env.BLOCK_RUNNER_NATIVE_HEADING_CONTROL_WORDPRESS_VERSION;
    if (controlPath || controlHash || controlVersion) {
      if (!controlPath || !controlHash || !controlVersion || !/^sha256:[a-f0-9]{64}$/.test(controlHash)) {
        throw new Error('All native Heading control evidence fields, including its SHA-256, must be supplied together.');
      }
      nativeHeadingControlEvidence = loadNativeHeadingControlEvidence({ wordpressVersion: controlVersion,
        evidence: { path: controlPath, sha256: controlHash as `sha256:${string}` } });
    }
    const paragraphControlPath = process.env.BLOCK_RUNNER_NATIVE_PARAGRAPH_CONTROL_EVIDENCE_PATH;
    const paragraphControlHash = process.env.BLOCK_RUNNER_NATIVE_PARAGRAPH_CONTROL_EVIDENCE_SHA256;
    const paragraphControlVersion = process.env.BLOCK_RUNNER_NATIVE_PARAGRAPH_CONTROL_WORDPRESS_VERSION;
    if (paragraphControlPath || paragraphControlHash || paragraphControlVersion) {
      if (!paragraphControlPath || !paragraphControlHash || !paragraphControlVersion || !/^sha256:[a-f0-9]{64}$/.test(paragraphControlHash)) {
        throw new Error('All native Paragraph control evidence fields, including its SHA-256, must be supplied together.');
      }
      nativeParagraphControlEvidence = loadNativeParagraphControlEvidence({ wordpressVersion: paragraphControlVersion,
        evidence: { path: paragraphControlPath, sha256: paragraphControlHash as `sha256:${string}` } });
    }
    baseline = await prove(baselineZip, 'baseline');
    const acceptance = evaluateReleaseAcceptance(baseline.receipt, {
      nativeHeadingControlEvidence,
      nativeParagraphControlEvidence,
    });
    await writeFile(path.join(root, 'baseline-acceptance.json'), JSON.stringify(summarizeReleaseAcceptance(acceptance), null, 2));
    expect(acceptance.automated.blockers, 'Every automated baseline gate must pass; only verified, approved upstream exceptions are accepted').toEqual([]);
    expect(acceptance.automated.ok).toBe(true);
  }, 480_000);

  const cases: Array<{
    name: string;
    file: string;
    mutate: (source: string) => string;
    target: ProofGateId;
    downstream: ProofGateId[];
  }> = [
    {
      name: 'registration',
      file: 'plugin.php',
      mutate: (source) => source.replace(/add_action\( 'init', '[^']+' \);/, '// Deliberate registration mutation.'),
      target: 'php_registry',
      downstream: ['rest_block_type', 'client_registry', 'editor_inserter', 'editor_field_editing', 'editor_save', 'editor_reopen',
        'pattern_overrides', 'frontend_status', 'frontend_semantics', 'frontend_links', 'frontend_media', 'frontend_assets',
        'frontend_runtime_errors', 'visual_regression', 'accessibility_editor', 'accessibility_frontend',
        'static_deactivation_html', 'static_deactivation_assets', 'static_deactivation_editor_controls'],
    },
    {
      name: 'save',
      file: 'src/blocks/pattern-overrides-fixture/save.js',
      mutate: (source) => source.replace('<div { ...innerBlocksProps } />', '<div { ...blockProps }><p>Deliberately lost native content</p></div>'),
      target: 'editor_save',
      downstream: ['editor_reopen', 'pattern_overrides', 'frontend_links', 'frontend_media', 'visual_regression'],
    },
    {
      name: 'stylesheet',
      file: 'src/blocks/pattern-overrides-fixture/block.json',
      mutate: (source) => {
        const metadata = JSON.parse(source);
        delete metadata.style;
        delete metadata.editorStyle;
        return JSON.stringify(metadata, null, 2);
      },
      target: 'frontend_assets',
      downstream: ['visual_regression', 'static_deactivation_assets'],
    },
    {
      name: 'pattern',
      file: 'src/blocks/pattern-overrides-fixture/edit.js',
      mutate: (source) => source.replaceAll('core/pattern-overrides', 'missing/pattern-source'),
      target: 'pattern_overrides',
      downstream: ['frontend_links', 'frontend_media', 'visual_regression'],
    },
  ];

  for (const candidate of cases) {
    it('detects ' + candidate.name + ' without accepting unrelated failures', async () => {
      const file = path.join(built.pluginDirectory, candidate.file);
      const original = await readFile(file, 'utf8');
      const changed = candidate.mutate(original);
      expect(changed, 'Mutation must actually change the production artifact').not.toBe(original);
      let mutatedZip: string;
      try {
        await writeFile(file, changed);
        const npmEnvironment = await npmEnvironmentForGeneratedPlugin(built.pluginDirectory);
        await execFile('npm', ['run', 'zip'], { cwd: built.pluginDirectory, timeout: 180_000,
          env: { ...npmEnvironment, NODE_ENV: 'production' } });
        mutatedZip = path.join(root, candidate.name + '.zip');
        await copyFile(built.pluginZip, mutatedZip);
      } finally {
        await writeFile(file, original);
      }
      const mutated = await prove(mutatedZip!, candidate.name);
      const acceptance = evaluateReleaseAcceptance(mutated.receipt, {
        nativeHeadingControlEvidence,
        nativeParagraphControlEvidence,
      });
      await writeFile(path.join(root, candidate.name + '-acceptance.json'), JSON.stringify(summarizeReleaseAcceptance(acceptance), null, 2));
      const allowed = new Set([candidate.target, ...candidate.downstream]);
      const matrix = baseline.receipt.gates.map((gate) => ({
        gate: gate.gate,
        baseline: gate.status,
        mutation: mutated.receipt.gates.find((record) => record.gate === gate.gate)?.status ?? 'missing',
        expectedImpact: allowed.has(gate.gate as ProofGateId),
      }));
      await writeFile(path.join(root, candidate.name + '-matrix.json'), JSON.stringify(matrix, null, 2));
      expect(matrix.find((row) => row.gate === candidate.target)?.baseline).toBe('pass');
      expect(matrix.find((row) => row.gate === candidate.target)?.mutation).toBe('fail');
      expect(matrix.filter((row) => !row.expectedImpact && row.mutation !== row.baseline),
        'Every gate outside the explicit causal impact set must match the passing baseline').toEqual([]);
      expect(acceptance.automated.blockers.filter(({ gate }) => !allowed.has(gate as ProofGateId)),
        'An unchanged raw failure status must not hide a new, unapproved finding outside the causal impact set').toEqual([]);
      expect(mutated.ok).toBe(false);
    }, 480_000);
  }

  async function prove(pluginZip: string, variant: string): Promise<ProofRunResult> {
    return runProof({
      profile: 'full', pluginZip, inputPath: built.inputPath,
      markup: built.nativeContainerMarkup, fixture: built.fixture,
      outputDir: path.join(root, variant + '-receipt'),
      keepEnvironment: true,
    });
  }
});
