import { bootHeadlessWordPress } from './env.js';
import { withMutedWordPressConsole } from './env.js';
import { WpBlock, WpModules } from '../types.js';

export async function getWp(): Promise<WpModules> {
  return bootHeadlessWordPress();
}

export async function createBlock(
  name: string,
  attributes: Record<string, unknown> = {},
  innerBlocks: WpBlock[] = [],
): Promise<WpBlock> {
  const wp = await getWp();
  return wp.createBlock(name, attributes, innerBlocks);
}

export async function parseMarkup(markup: string): Promise<WpBlock[]> {
  const wp = await getWp();
  return wp.parse(markup, { __unstableSkipMigrationLogs: true });
}

export async function serializeBlocks(blocks: WpBlock[] | WpBlock): Promise<string> {
  const wp = await getWp();
  return wp.serialize(blocks);
}

export async function validateWpBlock(block: WpBlock): Promise<[boolean, unknown[]?]> {
  const wp = await getWp();
  return withMutedWordPressConsole(() => wp.validateBlock(block));
}
