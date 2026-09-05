import { createRequire } from 'node:module';
import { bootHeadlessWordPressSync, withMutedWordPressConsole } from '../headless/env.js';
import type { AuthoringField, AuthoringStructureNode } from './schema.js';
import type { WpBlock } from '../types.js';

/** Pinned local registry and the deliberately narrow static-authoring policy. */
export const AUTHORING_NATIVE_POLICY_VERSION = '1' as const;

export interface AuthoringRegistryIdentity {
  /** Target WordPress schema/registry contract; package versions below are the observed evidence. */
  wordpress: '7.1';
  blockLibrary: string;
  blocks: string;
  policy: typeof AUTHORING_NATIVE_POLICY_VERSION;
}

interface RegisteredBlockType {
  name?: string;
  attributes?: Record<string, unknown>;
  allowedBlocks?: string[];
  parent?: string[];
  ancestor?: string[];
}

// Metadata attributes can be implementation details; only these have a supported editor surface.
const NATIVE_EDITING_SURFACES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'core/heading': ['content'],
  'core/paragraph': ['content'],
  'core/list-item': ['content'],
  'core/image': ['id', 'url', 'title', 'alt', 'caption'],
  'core/button': ['text', 'url', 'linkTarget', 'rel'],
});

const require = createRequire(import.meta.url);

export function authoringRegistryIdentity(): AuthoringRegistryIdentity {
  const blockLibrary = require('@wordpress/block-library/package.json') as { version: string };
  const blocks = require('@wordpress/blocks/package.json') as { version: string };
  return { wordpress: '7.1', blockLibrary: blockLibrary.version, blocks: blocks.version, policy: AUTHORING_NATIVE_POLICY_VERSION };
}

/** Validate registered native blocks, their explicit nesting restrictions, and their pinned save path. */
export function validateNativeComposition(nodes: readonly AuthoringStructureNode[]): void {
  const wp = bootHeadlessWordPressSync();
  const visit = (items: readonly AuthoringStructureNode[], parent: RegisteredBlockType | undefined, ancestors: string[], path: string): ReturnType<typeof wp.createBlock>[] => {
    const blocks: ReturnType<typeof wp.createBlock>[] = [];
    for (const [index, node] of items.entries()) {
      const nodePath = `${path}[${index}]`;
      const blockType = wp.getBlockType(node.block) as RegisteredBlockType | undefined;
      if (!blockType) fail('unknown-native-block: block is not registered by the pinned WordPress registry', `${nodePath}.block`);
      if (node.block === 'core/html') fail('unsupported-native-block: core/html is opaque and cannot be a static native child', `${nodePath}.block`);
      if (parent?.allowedBlocks && !parent.allowedBlocks.includes(node.block)) {
        fail(`incompatible-native-child: ${JSON.stringify(node.block)} is not allowed inside ${JSON.stringify(parent.name)}`, `${nodePath}.block`);
      }
      if (blockType.parent?.length && !blockType.parent.includes(parent?.name ?? '')) {
        fail(`incompatible-native-child: ${JSON.stringify(node.block)} requires a direct parent in ${JSON.stringify(blockType.parent)}`, `${nodePath}.block`);
      }
      if (blockType.ancestor?.length && !ancestors.some((ancestor) => blockType.ancestor!.includes(ancestor))) {
        fail(`incompatible-native-child: ${JSON.stringify(node.block)} requires an ancestor in ${JSON.stringify(blockType.ancestor)}`, `${nodePath}.block`);
      }
      const children = visit(node.children ?? [], blockType, [...ancestors, node.block], `${nodePath}.children`);
      const block = wp.createBlock(node.block, node.attributes as Record<string, unknown> | undefined, children);
      const roundTrip = withMutedWordPressConsole(() => wp.parse(wp.serialize(block)));
      const parsed = roundTrip[0];
      if (!parsed || !withMutedWordPressConsole(() => wp.validateBlock(parsed)[0])) {
        fail('invalid-native-serialization: pinned WordPress cannot validate this native block data', nodePath);
      }
      // A leaf save function may silently ignore supplied InnerBlocks and still produce valid
      // markup. Prove that the requested native tree survived, not only that what remains is valid.
      if (roundTrip.length !== 1 || treeShape(block) !== treeShape(parsed)) {
        fail('lossy-native-serialization: pinned WordPress did not preserve the requested native child tree', `${nodePath}.children`);
      }
      blocks.push(block);
    }
    return blocks;
  };
  visit(nodes, undefined, [], 'structure');
}

function treeShape(block: WpBlock): string {
  return JSON.stringify([block.name, block.innerBlocks.map(treeShape)]);
}

export function validateEditableField(field: AuthoringField, index: number, node: AuthoringStructureNode | undefined): void {
  if (!node || !field.attribute) return;
  const path = `fields[${index}].attribute`;
  const blockType = bootHeadlessWordPressSync().getBlockType(node.block) as RegisteredBlockType | undefined;
  if (!blockType?.attributes || !(field.attribute in blockType.attributes)) {
    fail(`unknown-native-attribute: ${JSON.stringify(field.attribute)} is not declared by ${JSON.stringify(node.block)} in the pinned WordPress registry`, path);
  }
  if (!NATIVE_EDITING_SURFACES[node.block]?.includes(field.attribute)) {
    fail(`unsupported-editor-field: ${JSON.stringify(field.attribute)} on ${JSON.stringify(node.block)} has no supported native editing surface`, path);
  }
}

function fail(reason: string, path: string): never {
  const error = new Error(`${reason} at ${path}`) as Error & { reason: string; source: { path: string } };
  error.name = 'AuthoringGenerationError';
  error.reason = reason;
  error.source = { path };
  throw error;
}
