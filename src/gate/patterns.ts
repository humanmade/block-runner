import type { ReportItem, WpBlock } from '../types.js';

/** Persisted synced-pattern instances reference a wp_block; they do not save children. */
export function patternReferenceProblem(block: WpBlock): string | undefined {
  if (block.name !== 'core/block' || (!block.innerBlocks.length && !block.originalContent?.trim())) {
    return undefined;
  }
  return 'Synced pattern references cannot contain inline blocks or HTML: serialization would discard that content. '
    + 'Use ref with content overrides keyed by the referenced pattern\'s metadata.name values, '
    + 'or explicitly detach the pattern into ordinary blocks. No automatic repair is safe.';
}

/** Check producer trees before serialization can erase evidence of a malformed reference. */
export function patternReferenceErrors(blocks: WpBlock[], sourcePath?: string): ReportItem[] {
  const items: ReportItem[] = [];
  const visit = (nodes: WpBlock[], parent: string): void => {
    for (const [index, block] of nodes.entries()) {
      const blockPath = `${parent}[${index}]`;
      const reason = patternReferenceProblem(block);
      if (reason) {
        items.push({
          block: block.name,
          status: 'invalid',
          reason,
          source: block.__blockRunnerSource ?? (sourcePath ? { path: sourcePath } : undefined),
          details: { blockPath, locationKind: 'block-tree' },
        });
      }
      visit(block.innerBlocks, `${blockPath}.innerBlocks`);
    }
  };
  visit(blocks, 'blocks');
  return items;
}
