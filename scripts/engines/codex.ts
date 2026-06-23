/**
 * Experimental LLM translator engine: convert HTML → Gutenberg block markup with
 * Codex (gpt-5.5), then validate the output through Block Runner's own gate.
 *
 * This is "Engine B" from md/02-architecture.md — the LLM does the structural
 * translation the deterministic rules can't, the gate enforces validity. Wire it
 * into the benchmark via:
 *   npm run bench -- --engine scripts/engines/codex.ts --engine-label codex \
 *     --model gpt-5.5 --effort low
 *
 * One codex call per fixture, so use --producer / --layouts to scope test runs.
 */
import { execFileSync } from 'node:child_process';
import { validate } from '../../src/index.js';
import { CONVERT_PROMPT as PROMPT, extractBlocks } from './prompt.js';
import type { ConvertOptions, BlockRunnerReport } from '../../src/types.js';

function reasoningEffort(): string {
  const i = process.argv.indexOf('--effort');
  const v = i >= 0 ? process.argv[i + 1] : process.env.BLOCK_RUNNER_EFFORT;
  return v && v !== 'none' && v !== 'n/a' ? v : 'low';
}

export async function convert(html: string, _opts?: ConvertOptions): Promise<BlockRunnerReport> {
  let markup = '';
  try {
    const out = execFileSync(
      'codex',
      ['exec', '-c', `model_reasoning_effort=${reasoningEffort()}`, '--dangerously-bypass-approvals-and-sandbox', '-'],
      { input: PROMPT + html, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'], timeout: 240000, killSignal: 'SIGKILL' },
    );
    markup = extractBlocks(out);
  } catch {
    markup = '';
  }

  // The LLM translated; the gate validates. Same contract as the deterministic engine.
  const gate = await validate(markup);
  return { ok: gate.ok, command: 'convert', summary: gate.summary, items: gate.items, output: markup };
}
