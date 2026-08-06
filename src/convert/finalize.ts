import { validate } from '../gate/validate.js';
import { applyMedia } from '../media/apply.js';
import { createMediaResolver } from '../media/resolver.js';
import { repairTokens } from '../tokens/apply.js';
import {
  BlockRunnerConfig,
  BlockRunnerReport,
  CommandName,
  CommonOptions,
  ReportItem,
  TokenConfig,
  WpBlock,
  WpModules,
} from '../types.js';

interface FinalizeContext {
  command: Extract<CommandName, 'convert' | 'assemble'>;
  warnings?: ReportItem[];
  tokens?: TokenConfig;
}

/**
 * Apply the post-assembly contract shared by every block-tree producer: resolve media, repair
 * brand tokens, serialize with Gutenberg, then run the validation gate.
 */
export async function finalizeBlocks(
  blocks: WpBlock[],
  options: CommonOptions,
  config: BlockRunnerConfig,
  wp: WpModules,
  context: FinalizeContext,
): Promise<BlockRunnerReport> {
  const warnings = [...(context.warnings ?? [])];
  warnings.push(...(await applyMedia(blocks, createMediaResolver(config, options), config)));

  const tokenRepair = await repairTokens(blocks, config, options, context.tokens);
  warnings.push(...tokenRepair.items);

  const output = wp.serialize(tokenRepair.blocks);
  const gate = await validate(output, {
    ...options,
    strict: config.strict,
  });

  const hardWarnings = warnings.filter((item) => isStrictFailureWarning(item));
  const ok = gate.summary.invalid === 0 && !(config.strict && hardWarnings.length > 0);

  return {
    ok,
    command: context.command,
    summary: {
      blocks: gate.summary.blocks,
      valid: gate.summary.valid,
      invalid: gate.summary.invalid,
      warnings: warnings.length,
    },
    items: [...warnings, ...gate.items],
    output,
  };
}

function isStrictFailureWarning(item: ReportItem): boolean {
  return /Custom HTML fallback|unresolved media|no ID|media map has no ID|sideload is disabled|file not found/i.test(
    item.reason,
  );
}
