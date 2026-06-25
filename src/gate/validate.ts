import { formatWithOptions } from 'node:util';
import { getWp } from '../headless/wp.js';
import { withMutedWordPressConsole } from '../headless/env.js';
import {
  BlockRunnerReport,
  ReportItem,
  ReportSummary,
  SourceLocation,
  ValidateOptions,
  WpBlock,
} from '../types.js';

export async function validate(markup: string, options: ValidateOptions = {}): Promise<BlockRunnerReport> {
  const wp = await getWp();
  // parse() validates each block internally and Gutenberg logs verbose validation
  // diffs to the console on invalid markup (the LLM-engine path). Mute it — the gate
  // below reports invalidity properly; the raw dump is ~700 KB of run-log noise.
  const blocks = withMutedWordPressConsole(() => wp.parse(markup, { __unstableSkipMigrationLogs: true }));
  const summary: ReportSummary = {
    blocks: 0,
    valid: 0,
    invalid: 0,
    warnings: 0,
  };
  const items: ReportItem[] = [];
  let searchOffset = 0;

  for (const block of flattenBlocks(blocks)) {
    summary.blocks += 1;
    const [isValid, issues] = withMutedWordPressConsole(() => wp.validateBlock(block));

    if (isValid) {
      summary.valid += 1;
      continue;
    }

    summary.invalid += 1;
    const source = locateBlock(markup, block, searchOffset, options.sourcePath);
    if (source.offset != null) {
      searchOffset = source.offset + 1;
    }
    items.push({
      block: block.name,
      status: 'invalid',
      reason: formatValidationIssues(issues),
      source,
    });
  }

  return {
    ok: summary.invalid === 0,
    command: 'validate',
    summary,
    items,
  };
}

export function flattenBlocks(blocks: WpBlock[]): WpBlock[] {
  const out: WpBlock[] = [];
  const visit = (block: WpBlock) => {
    out.push(block);
    for (const child of block.innerBlocks ?? []) {
      visit(child);
    }
  };

  for (const block of blocks) {
    visit(block);
  }

  return out;
}

export function formatValidationIssues(issues: unknown[] | undefined): string {
  if (!issues || issues.length === 0) {
    return 'invalid block markup';
  }

  const messages = issues
    .map(formatValidationIssue)
    .filter((message): message is string => Boolean(message));

  return messages.length > 0 ? messages.join('; ') : 'invalid block markup';
}

// Gutenberg's `validateBlock` returns `LoggerItem`s of the shape
// `{ log, args }`, where `args` is a printf-style format string followed by its
// substitution values (e.g. `['Expected attributes %o, instead saw %o.', a, b]`).
// Render them with `util.format` to recover the human-readable message; skip the
// catch-all "Block validation failed for …" item, which only restates that the
// block is invalid while dumping the entire block type definition.
function formatValidationIssue(issue: unknown): string {
  if (typeof issue === 'string') {
    return issue;
  }
  if (issue && typeof issue === 'object') {
    const { args, message } = issue as { args?: unknown[]; message?: unknown };
    if (Array.isArray(args) && args.length > 0) {
      if (typeof args[0] === 'string' && args[0].startsWith('Block validation failed for')) {
        return '';
      }
      // `%o` (lower-case) renders with `showHidden`, leaking `[length]: N`
      // artifacts into otherwise plain arrays/objects; `%O` inspects cleanly.
      const format = typeof args[0] === 'string' ? args[0].replace(/%o/g, '%O') : args[0];
      return formatWithOptions({ depth: 2, breakLength: Infinity }, format, ...args.slice(1)).trim();
    }
    if (message != null) {
      return String(message);
    }
  }
  return String(issue);
}

function locateBlock(markup: string, block: WpBlock, fromOffset: number, path?: string): SourceLocation {
  const needles = [`<!-- wp:${block.name.replace(/^core\//, '')}`, block.originalContent ?? ''].filter(Boolean);
  let offset = -1;

  for (const needle of needles) {
    offset = markup.indexOf(needle, fromOffset);
    if (offset !== -1) {
      break;
    }
  }

  if (offset === -1) {
    return { path };
  }

  const { line, column } = lineColumnAt(markup, offset);
  return {
    path,
    htmlLine: line,
    htmlColumn: column,
    offset,
  };
}

function lineColumnAt(input: string, offset: number): { line: number; column: number } {
  const before = input.slice(0, offset);
  const lines = before.split(/\r\n|\r|\n/);
  return {
    line: lines.length,
    column: lines.at(-1)!.length + 1,
  };
}
