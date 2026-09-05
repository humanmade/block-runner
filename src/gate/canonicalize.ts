import { loadConfig } from '../config/load.js';
import { JSDOM } from 'jsdom';
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
function rebuildInvalidBlocks(blocks: WpBlock[], wp: WpModules, repairs: BlockRunnerReport['items'], parent = 'blocks'): WpBlock[] {
  return blocks.map((block, index) => {
    const source = { path: `${parent}[${index}]` };
    const innerBlocks = block.innerBlocks?.length ? rebuildInvalidBlocks(block.innerBlocks, wp, repairs, `${source.path}.innerBlocks`) : [];

    if (block.isValid === false && block.name && block.name !== 'core/missing' && wp.getBlockType(block.name)) {
      const candidate = wp.createBlock(block.name, block.attributes, innerBlocks);
      const serialized = wp.serialize(candidate);
      const reopened = wp.parse(serialized, { __unstableSkipMigrationLogs: true });
      const valid = (item: WpBlock): boolean => wp.validateBlock(item)[0] && item.innerBlocks.every(valid);
      const shape = (item: WpBlock): unknown => [item.name, item.innerBlocks.map(shape)];
      if (reopened.length !== 1 || !valid(reopened[0]!)
        || JSON.stringify(shape(candidate)) !== JSON.stringify(shape(reopened[0]!))
        || contentInventory(wp.serialize(block)) !== contentInventory(serialized)) {
        repairs.push({ block: block.name, status: 'warning', source,
          reason: 'Invalid block left unchanged: rebuilding could not prove valid, content-preserving output.' });
        return block;
      }
      repairs.push({ block: block.name, status: 'warning', source,
        reason: 'Invalid block rebuilt from parsed attributes; text and media references were retained, but original styling may differ.' });
      return candidate;
    }

    return { ...block, innerBlocks };
  });
}

function contentInventory(markup: string): string {
  const fragment = JSDOM.fragment(markup);
  const references = [...fragment.querySelectorAll('*')].flatMap((element) =>
    ['src', 'href', 'srcset', 'poster', 'alt'].filter((name) => element.hasAttribute(name))
      .map((name) => [name, element.getAttribute(name)]));
  return JSON.stringify([(fragment.textContent ?? '').replace(/\s+/g, ' ').trim(), references]);
}

export async function canonicalize(markup: string, options: CanonicalizeOptions = {}): Promise<BlockRunnerReport> {
  const wp = await getWp();
  const config = await loadConfig(options);

  const parsed = withMutedWordPressConsole(() => wp.parse(markup, { __unstableSkipMigrationLogs: true }));
  let repairs: BlockRunnerReport['items'] = [];

  // createBlock revalidates as it rebuilds; Gutenberg dumps large validation
  // diffs the gate mutes elsewhere, so mute them here too.
  let blocks = withMutedWordPressConsole(() => rebuildInvalidBlocks(parsed, wp, repairs));

  if (!(buildTokenInverseMap(config.tokens).isEmpty && (config.tokens?.resolver ?? 'noop') === 'noop')) {
    const result = await repairTokens(blocks, config, options);
    repairs = [...repairs, ...result.items];
    blocks = result.blocks;
  }

  const output = wp.serialize(blocks);
  const report = await validate(output, options);

  return {
    ...report,
    summary: { ...report.summary, warnings: report.summary.warnings + repairs.filter((item) => item.status === 'warning').length },
    ok: report.summary.invalid === 0,
    command: 'fix',
    items: [...repairs, ...report.items],
    output,
  };
}
