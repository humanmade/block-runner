import { BlockRunnerConfig, MediaResolver, ReportItem, WpBlock } from '../types.js';

export async function applyMedia(
  blocks: WpBlock[],
  resolver: MediaResolver,
  config: BlockRunnerConfig,
): Promise<ReportItem[]> {
  const warnings: ReportItem[] = [];

  for (const block of blocks) {
    await visit(block, resolver, config, warnings);
  }

  return warnings;
}

async function visit(
  block: WpBlock,
  resolver: MediaResolver,
  config: BlockRunnerConfig,
  warnings: ReportItem[],
): Promise<void> {
  if ((block.name === 'core/cover' || block.name === 'core/image') && typeof block.attributes.url === 'string') {
    const kind = block.name === 'core/cover' ? 'cover' : 'image';
    if (typeof block.attributes.id !== 'number') {
      const result = await resolver.resolve({
        urlOrPath: block.attributes.url,
        kind,
        source: block.__blockRunnerSource,
      });
      block.attributes.url = result.url;
      if (typeof result.id === 'number') {
        block.attributes.id = result.id;
      }

      if (!result.resolved || result.id == null) {
        warnings.push({
          block: block.name,
          status: 'warning',
          reason: result.reason ?? 'unresolved media',
          source: block.__blockRunnerSource,
          details: {
            resolver: resolver.kind,
            strict: config.strict === true,
          },
        });
      }
    }
  }

  for (const child of block.innerBlocks ?? []) {
    await visit(child, resolver, config, warnings);
  }
}
