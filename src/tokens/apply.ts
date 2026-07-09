import { withMutedWordPressConsole } from '../headless/env.js';
import { getWp } from '../headless/wp.js';
import { BlockRunnerConfig, CommonOptions, ReportItem, TokenConfig, WpBlock } from '../types.js';
import { applyTokens, buildTokenInverseMap } from './repair.js';
import { createTokenResolver } from './resolver.js';

export interface TokenRepairResult {
  items: ReportItem[];
  blocks: WpBlock[];
}

// Resolve external tokens (theme.json / REST / WP-CLI) and merge them UNDER the
// user's explicit config tokens, then repair hardcoded values in `blocks` to
// preset slugs. Mutates the parsed attributes in place; when any repair lands the
// affected tree is rebuilt via createBlock so each block's save() re-runs against
// the new attributes (a parsed block reuses its original innerHTML on serialize,
// so the preset classes would otherwise never reach the rendered markup). Returns
// the report items and the blocks to serialize. When no effective tokens exist the
// walk is skipped entirely (no behaviour change).
export async function repairTokens(
  blocks: WpBlock[],
  config: BlockRunnerConfig,
  options: CommonOptions,
): Promise<TokenRepairResult> {
  const effective = await effectiveTokens(config, options);
  const invMap = buildTokenInverseMap(effective);
  if (invMap.isEmpty) {
    return { items: [], blocks };
  }
  const items = applyTokens(blocks, invMap, effective);
  if (items.length === 0) {
    return { items, blocks };
  }
  const wp = await getWp();
  // createBlock revalidates each block as it rebuilds; Gutenberg dumps the same
  // ~700 KB validation diffs the gate already mutes elsewhere. Mute them here too.
  return { items, blocks: withMutedWordPressConsole(() => blocks.map((block) => rebuild(block, wp))) };
}

function rebuild(block: WpBlock, wp: Awaited<ReturnType<typeof getWp>>): WpBlock {
  return wp.createBlock(
    block.name,
    block.attributes,
    (block.innerBlocks ?? []).map((child) => rebuild(child, wp)),
  );
}

async function effectiveTokens(config: BlockRunnerConfig, options: CommonOptions): Promise<TokenConfig> {
  const tokens = config.tokens ?? {};
  const resolverKind = options.tokenResolver ?? tokens.resolver ?? 'noop';
  if (resolverKind === 'noop') {
    return tokens;
  }

  const resolved = await createTokenResolver(config, options).resolve();
  // A non-empty array is a legacy slug-only list (no values to match on, so it
  // can't drive repair, but preserve it). An empty array is the schema default —
  // it must NOT shadow resolved spacing. Anything else is a value map; merge
  // resolved under the user's explicit entries.
  const configSpacing = tokens.spacing;
  const spacing =
    Array.isArray(configSpacing) && configSpacing.length > 0
      ? configSpacing
      : { ...resolved.spacing, ...(Array.isArray(configSpacing) ? {} : (configSpacing ?? {})) };

  return {
    ...tokens,
    colors: { ...resolved.colors, ...tokens.colors },
    fonts: { ...resolved.fonts, ...tokens.fonts },
    fontSizes: { ...resolved.fontSizes, ...tokens.fontSizes },
    spacing,
  };
}
