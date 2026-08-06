/**
 * Engine Skill — measures the SHIPPED guide, not the tuned prompt.
 *
 * Engine C sends the tuner-owned `INTENT_PROMPT`. This engine sends `skill/GUIDE.md` — the
 * text we actually publish — plus the minimal task framing a real agent would supply. Same
 * `realize()` on the other side, so the only variable is the instructions.
 *
 * The point is that the guide is a rewrite of the prompt for human/agent readers, carrying
 * extra material (the validate loop, tokens, failure posture) that the tuned prompt never had.
 * That extra material is realistic noise; this is how we find out what it costs.
 *
 *   npm run bench -- --engine scripts/engines/engine-skill.ts --model opus \
 *     --producer claude-impeccable --layouts hero-cover,pricing-table
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConvertOptions, BlockRunnerReport } from '../../src/types.js';
import { realize } from './intent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUIDE = readFileSync(path.join(ROOT, 'skill', 'GUIDE.md'), 'utf8');

// The framing an agent supplies around the guide when it has been handed a design to convert.
// Deliberately thin: any lifting here is lifting the guide is not doing.
const TASK = `
---

Your task: convert the HTML below into an intent tree, following the guide above.

Output ONLY the intent JSON, between a line ===INTENT_START=== and a line ===INTENT_END===.
Do not run any commands, write any files, or output block markup.

HTML:
`;

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

export async function propose(html: string, _opts?: ConvertOptions): Promise<{ raw: string }> {
  try {
    return { raw: callModel(GUIDE + TASK + html) };
  } catch {
    return { raw: '' };
  }
}

export { realize };

export async function convert(html: string, opts?: ConvertOptions): Promise<BlockRunnerReport> {
  const { raw } = await propose(html, opts);
  return realize(raw, opts);
}
