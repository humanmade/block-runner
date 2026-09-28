import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { realize, validate } from '../../src/index.js';
import { getWp } from '../../src/headless/wp.js';
import type { IntentNode, IntentTree, WpBlock } from '../../src/types.js';

const shape = (block: WpBlock): unknown => [block.name, block.innerBlocks.map(shape)];
const intentShape = (node: IntentNode): unknown => [node.block, (node.children ?? []).map(intentShape)];

for (const variant of ['plain', 'rich', 'independent'] as const) {
  describe(`native Tabs: ${variant}`, () => {
    it('preserves nesting, labels, content and active index through the shared gate', async () => {
      const tree = JSON.parse(await readFile(new URL('./fixtures/tabs.intent.json', import.meta.url), 'utf8')) as IntentTree;
      if (variant === 'rich') {
        tree.blocks[0]!.children![1]!.children![1]!.children!.push(
          { block: 'core/heading', text: 'Panel heading' },
          { block: 'core/list', items: ['First item', 'Second item'] },
          { block: 'core/buttons', children: [{ block: 'core/button', text: 'Read more', url: 'https://example.org/details' }] },
        );
      }
      if (variant === 'independent') {
        const second = structuredClone(tree.blocks[0]!);
        second.attrs = { activeTabIndex: 1 };
        tree.blocks.push(second);
      }
      const report = await realize(JSON.stringify(tree));
      expect(report.ok, JSON.stringify(report.items)).toBe(true);
      expect(report.summary).toMatchObject({ invalid: 0, warnings: 0 });
      expect(report.output).not.toMatch(/wp:(?:html|freeform)/);
      const wp = await getWp();
      const parsed = wp.parse(report.output!);
      // List shorthand expands into native list items.
      if (variant !== 'rich') expect(parsed.map(shape)).toEqual(tree.blocks.map(intentShape));
      for (const [index, tabs] of parsed.entries()) {
        expect(tabs.attributes.activeTabIndex).toBe(index === 1 ? 1 : 0);
        expect(tabs.innerBlocks.map((block) => block.name)).toEqual(['core/tab-list', 'core/tab-panels']);
        expect(JSON.parse(JSON.stringify(tabs.innerBlocks[0]!.attributes.tabs))).toEqual([{ label: 'Overview' }, { label: 'Details' }]);
        expect(tabs.innerBlocks[1]!.innerBlocks.map((block) => block.attributes.label)).toEqual(['Overview', 'Details']);
      }
      expect(report.output).toContain('First panel content.');
      expect(report.output).toContain('Second panel content.');
      if (variant === 'rich') {
        for (const value of ['Panel heading', 'First item', 'Second item', 'Read more', 'https://example.org/details']) expect(report.output).toContain(value);
        expect(parsed[0]!.innerBlocks[1]!.innerBlocks[1]!.innerBlocks.map((block) => block.name)).toEqual(['core/paragraph', 'core/heading', 'core/list', 'core/buttons']);
      }
      expect((await validate(report.output!)).ok).toBe(true);
      expect(wp.serialize(parsed)).toBe(report.output);
    });
  });
}
