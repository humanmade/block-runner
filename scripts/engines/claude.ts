/**
 * Experimental LLM translator engine: convert HTML → Gutenberg block markup with
 * Claude Code (the harness, `claude -p` — no API key), then validate through the gate.
 *
 * Engine B with Claude. Wire into the benchmark via:
 *   npm run bench -- --engine scripts/engines/claude.ts --engine-label claude-code \
 *     --model opus-4.8 --effort high
 *
 * Uses `--model opus` (alias → latest Opus) and bypassPermissions so the headless run
 * never blocks. Note: the CLI exposes no reasoning-effort knob, so --effort is a record
 * label only (thinking is the harness default). One claude call per fixture.
 */
import { execFileSync } from 'node:child_process';
import { validate } from '../../src/index.js';
import { CONVERT_PROMPT as PROMPT, extractBlocks } from './prompt.js';
import type { ConvertOptions, BlockRunnerReport } from '../../src/types.js';

export async function convert(html: string, _opts?: ConvertOptions): Promise<BlockRunnerReport> {
  let markup = '';
  try {
    const out = execFileSync('claude', ['-p', '--model', 'opus', '--permission-mode', 'bypassPermissions'], {
      input: PROMPT + html,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 240000,
      killSignal: 'SIGKILL',
    });
    markup = extractBlocks(out);
  } catch {
    markup = '';
  }

  const gate = await validate(markup);
  return { ok: gate.ok, command: 'convert', summary: gate.summary, items: gate.items, output: markup };
}
