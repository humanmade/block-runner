import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { realize, validate } from '../../src/index.js';
import { getWp } from '../../src/headless/wp.js';
import type { IntentTree, WpBlock } from '../../src/types.js';

const fixturePath = fileURLToPath(new URL('./fixtures/query-loop.intent.json', import.meta.url));
const shape = (block: WpBlock): unknown => [block.name, block.innerBlocks.map(shape)];
const expectedShape = ['core/query', [
  ['core/post-template', [['core/post-title', []]]],
  ['core/query-pagination', [['core/query-pagination-previous', []], ['core/query-pagination-numbers', []], ['core/query-pagination-next', []]]],
  ['core/query-no-results', [['core/paragraph', []]]],
]];

async function queryIntent(): Promise<IntentTree> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as IntentTree;
}

describe('Query Loop intent assembly', () => {
  it('preserves registered Query Loop structure and attributes through the gate', async () => {
    const report = await realize(JSON.stringify(await queryIntent()));

    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect(report.summary.invalid).toBe(0);
    expect(report.items).not.toContainEqual(expect.objectContaining({ reason: 'block type is not registered' }));
    expect(report.output).not.toMatch(/wp:(?:html|freeform)/);

    const wp = await getWp();
    const parsed = wp.parse(report.output!);
    expect(parsed.map(shape)).toEqual([expectedShape]);
    expect(parsed[0]!.attributes).toMatchObject({
      queryId: 1,
      query: { perPage: 1, postType: 'post', order: 'asc', orderBy: 'date', inherit: false },
    });
    expect(parsed[0]!.innerBlocks[0]!.innerBlocks[0]!.attributes).toMatchObject({ isLink: true });
    expect(report.output).toContain('<p>No matching posts.</p>');
    expect((await validate(report.output!)).ok).toBe(true);
    expect(wp.serialize(parsed)).toBe(report.output);
  });

  it('preserves an unmatched search value without claiming runtime results', async () => {
    const intent = await queryIntent();
    intent.blocks[0]!.attrs = {
      ...intent.blocks[0]!.attrs,
      query: { ...(intent.blocks[0]!.attrs!.query as Record<string, unknown>), search: '__block_runner_unmatched_search__' },
    };
    const report = await realize(JSON.stringify(intent));
    const parsed = (await getWp()).parse(report.output!);

    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect(parsed[0]!.attributes).toMatchObject({ query: { search: '__block_runner_unmatched_search__' } });
  });

  it('keeps a current taxonomy binding valid for the runtime fixture', async () => {
    const intent = await queryIntent();
    intent.blocks[0]!.attrs = {
      ...intent.blocks[0]!.attrs,
      query: { ...(intent.blocks[0]!.attrs!.query as Record<string, unknown>), taxQuery: { include: { category: [123] } } },
    };
    const report = await realize(JSON.stringify(intent));

    expect(report.ok, JSON.stringify(report.items)).toBe(true);
    expect((await getWp()).parse(report.output!)[0]!.attributes).toMatchObject({
      query: { taxQuery: { include: { category: [123] } } },
    });
  });
});
