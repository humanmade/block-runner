/**
 * Experimental LLM translator engine: convert HTML → Gutenberg block markup with
 * Claude Code (the harness, `claude -p` — no API key), then validate through the gate.
 *
 * Engine B with Claude. Wire into the benchmark via:
 *   npm run bench -- --engine scripts/engines/claude.ts --engine-label claude-code \
 *     --model opus-4.8 --effort high
 *
 * Uses `--model opus` (alias → latest Opus) in restricted, non-persistent mode. --effort is
 * passed through to the CLI's own --effort flag (low|medium|high|xhigh|max), so a run labelled
 * 'low' really is low. One claude call per fixture.
 */
import { execFileSync } from 'node:child_process';
import { validate } from '../../src/index.js';
import { CONVERT_PROMPT as PROMPT, CONVERT_PROMPT_HASH, extractBlocks } from './prompt.js';
import { claudePrintArgs, MODEL_WORKDIR } from './harness.js';
import type { ConvertOptions, BlockRunnerReport } from '../../src/types.js';

function reasoningEffort(): string {
  const i = process.argv.indexOf('--effort');
  const v = (i >= 0 ? process.argv[i + 1] : process.env.BLOCK_RUNNER_EFFORT) ?? 'high';
  return v === 'none' || v === 'n/a' ? 'high' : v;
}

function modelName(): string {
  const i = process.argv.indexOf('--model');
  return (i >= 0 ? process.argv[i + 1] : process.env.BLOCK_RUNNER_MODEL) ?? 'opus';
}

export async function convert(html: string, _opts?: ConvertOptions): Promise<BlockRunnerReport> {
  let markup = '';
  let engineError: string | undefined;
  try {
    const out = execFileSync('claude', claudePrintArgs(modelName(), reasoningEffort()), {
      cwd: MODEL_WORKDIR,
      input: PROMPT + html,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 240000,
      killSignal: 'SIGKILL',
    });
    markup = extractBlocks(out);
  } catch (error) {
    markup = '';
    engineError = error instanceof Error ? error.message : String(error);
  }

  const gate = await validate(markup);
  const report: BlockRunnerReport = { ok: gate.ok, command: 'convert', summary: gate.summary, items: gate.items, output: markup };
  if (engineError !== undefined) {
    // BlockRunnerReport is shipped without benchmark failure metadata; this harness-only field keeps a failed call distinct from a real zero.
    return { ...report, engineError } as BlockRunnerReport & { engineError: string };
  }
  return report;
}

export const promptHash = CONVERT_PROMPT_HASH;
