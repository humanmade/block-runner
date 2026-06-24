/**
 * Engine C — the split engine. The LLM emits a typed block-intent tree (propose); the
 * deterministic core (intent.ts) assembles it into valid-by-construction markup (realize).
 *
 * This is the synthesis of md/13: it keeps Engine B's structural wins (handles messy input,
 * knows media-text/details) WITHOUT Engine B's invalidity (because code, not the model,
 * writes the markup) and WITHOUT the rules' spaghetti. It bounds every failure to "wrong
 * structure/attributes" and structurally eliminates "invalid markup."
 *
 * It exposes the tuner's split contract — propose / realize / promptHash — so T0 replays the
 * cached intent through realize() for free, calling the model only when the prompt changes.
 *
 *   npm run tune -- --tier t2 --engine scripts/engines/engine-c.ts --engine-label engine-c --model opus
 *   npm run tune -- --tier t2 --engine scripts/engines/engine-c.ts --engine-label engine-c --model gpt-5.5 --cli codex --effort high
 *
 * CLI selection: --cli claude (default; harness/OAuth, no API key) or --cli codex. The model
 * decides structure; the assembler guarantees validity — so the same code drives any model.
 */
import { execFileSync } from 'node:child_process';
import type { ConvertOptions, BlockRunnerReport } from '../../src/types.js';
import { INTENT_PROMPT, PROMPT_HASH, realize } from './intent.js';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function cli(): 'claude' | 'codex' {
  const c = flag('--cli') ?? (flag('--model', '')!.startsWith('gpt') ? 'codex' : 'claude');
  return c === 'codex' ? 'codex' : 'claude';
}
function modelName(): string {
  return flag('--model') ?? process.env.BLOCK_RUNNER_MODEL ?? (cli() === 'codex' ? 'gpt-5.5' : 'opus');
}
function reasoningEffort(): string {
  const v = flag('--effort') ?? process.env.BLOCK_RUNNER_EFFORT;
  return v && v !== 'none' && v !== 'n/a' ? v : 'high';
}

function callModel(input: string): string {
  if (cli() === 'codex') {
    return execFileSync(
      'codex',
      ['exec', '-m', modelName(), '-c', `model_reasoning_effort=${reasoningEffort()}`, '--dangerously-bypass-approvals-and-sandbox', '-'],
      { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'], timeout: 240000, killSignal: 'SIGKILL' },
    );
  }
  return execFileSync('claude', ['-p', '--model', modelName(), '--permission-mode', 'bypassPermissions'], {
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 240000,
    killSignal: 'SIGKILL',
  });
}

// The costly, non-deterministic half: ask the model for an intent tree. Its raw response is
// what the tuner caches; realize() (deterministic) is replayed over it.
export async function propose(html: string, _opts?: ConvertOptions): Promise<{ raw: string }> {
  try {
    return { raw: callModel(INTENT_PROMPT + html) };
  } catch {
    return { raw: '' };
  }
}

export { realize };
export const promptHash = PROMPT_HASH;

// convert = propose + realize, for non-tuner callers (e.g. plain `npm run bench`).
export async function convert(html: string, opts?: ConvertOptions): Promise<BlockRunnerReport> {
  const { raw } = await propose(html, opts);
  return realize(raw, opts);
}
