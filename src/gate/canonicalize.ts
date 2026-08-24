import { loadConfig } from '../config/load.js';
import { withMutedWordPressConsole } from '../headless/env.js';
import { getWp } from '../headless/wp.js';
import { repairTokens } from '../tokens/apply.js';
import { buildTokenInverseMap } from '../tokens/repair.js';
import { BlockRunnerReport, CanonicalizeOptions, WpBlock, WpModules } from '../types.js';
import { validate } from './validate.js';

/**
 * Rebuild genuinely-invalid registered blocks from their parsed attributes.
 *
 * `serialize(parse(markup))` alone canonicalizes near-misses (attribute order,
 * whitespace, generated classes) but does NOT repair a block whose stored HTML
 * fails validation: the WP serializer re-emits `originalContent` verbatim for a
 * block with `isValid === false`, so it round-trips still broken. Re-creating
 * such a block through `createBlock` discards the drifted HTML and re-runs its
 * `save()` from the parsed attributes — repairing near-miss structures that no
 * deprecation covers (e.g. an image without its `<figure>` wrapper, a button
 * without `wp-block-button__link`). This mirrors what the token-repair path
 * already does after mutating attributes.
 *
 * Only registered, invalid blocks are rebuilt; valid blocks keep their parsed
 * form (with any repaired descendants), and unregistered blocks (`core/missing`,
 * custom blocks) pass through untouched.
 */
function rebuildInvalidBlocks(blocks: WpBlock[], wp: WpModules): WpBlock[] {
  return blocks.map((block) => {
    const innerBlocks = block.innerBlocks?.length ? rebuildInvalidBlocks(block.innerBlocks, wp) : [];

    if (block.isValid === false && block.name && wp.getBlockType(block.name)) {
      return wp.createBlock(block.name, block.attributes, innerBlocks);
    }

    return { ...block, innerBlocks };
  });
}

export async function canonicalize(markup: string, options: CanonicalizeOptions = {}): Promise<BlockRunnerReport> {
  const wp = await getWp();
  const config = await loadConfig(options);

  const parsed = wp.parse(markup, { __unstableSkipMigrationLogs: true });

  // createBlock revalidates as it rebuilds; Gutenberg dumps large validation
  // diffs the gate mutes elsewhere, so mute them here too.
  let blocks = withMutedWordPressConsole(() => rebuildInvalidBlocks(parsed, wp));

  let repairs: BlockRunnerReport['items'] = [];
  if (!(buildTokenInverseMap(config.tokens).isEmpty && (config.tokens?.resolver ?? 'noop') === 'noop')) {
    const result = await repairTokens(blocks, config, options);
    repairs = result.items;
    blocks = result.blocks;
  }

  const output = wp.serialize(blocks);
  const report = await validate(output, options);

  return {
    ...report,
    ok: report.summary.invalid === 0,
    command: 'fix',
    items: [...repairs, ...report.items],
    output,
  };
}
