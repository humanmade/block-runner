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
import type { ConvertOptions, BlockRunnerReport } from '../../src/types.js';

const PROMPT = `Convert the HTML below into valid WordPress Gutenberg block markup using CORE blocks only:
core/cover, core/columns, core/column, core/media-text, core/group, core/heading,
core/paragraph, core/list, core/list-item, core/buttons, core/button, core/image,
core/quote, core/details, core/gallery, core/table.

Reconstruct the design's intent as a clean, correctly-nested native block tree — e.g. a
hero with a background image is a core/cover; image-beside-text is a core/media-text; an
FAQ is one core/details per question; a logo row is images in a group. Avoid core/html.

Output ONLY the block markup (the <!-- wp:... --> delimiters and their HTML), nothing
else, wrapped exactly between a line ===BLOCKS_START=== and a line ===BLOCKS_END===.
Do not run any commands or write any files.

HTML:
`;

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
      { input: PROMPT + html, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const m = out.match(/===BLOCKS_START===([\s\S]*?)===BLOCKS_END===/);
    markup = (m ? m[1] : '').trim();
  } catch {
    markup = '';
  }

  // The LLM translated; the gate validates. Same contract as the deterministic engine.
  const gate = await validate(markup);
  return { ok: gate.ok, command: 'convert', summary: gate.summary, items: gate.items, output: markup };
}
