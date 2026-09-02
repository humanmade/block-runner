import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getWp } from '../src/headless/wp.js';
import { realize } from '../src/index.js';
import { INTENT_PROMPT } from '../scripts/engines/intent.js';
import { CONVERT_PROMPT } from '../scripts/engines/prompt.js';
import { claudePrintArgs, codexExecArgs, MODEL_WORKDIR } from '../scripts/engines/harness.js';
import {
  WORDPRESS_TARGET,
  expectedToDisplay,
  gutenbergVersion,
  loadSpecs,
  matchNode,
  scoreReport,
  type ExpectedNode,
  type Spec,
  type Tally,
} from '../scripts/tuner/score.js';
import type { IntentTree, WpBlock } from '../src/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function allTrees(spec: Spec): ExpectedNode[] {
  return [spec.tree, ...spec.acceptedTrees];
}

function walk(node: ExpectedNode, visit: (node: ExpectedNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function findNodes(spec: Spec, block: string): ExpectedNode[] {
  const found: ExpectedNode[] = [];
  for (const tree of allTrees(spec)) walk(tree, (node) => node.block === block && found.push(node));
  return found;
}

describe('benchmark contract', () => {
  it('scores exact Gutenberg attributes as content assertions', () => {
    const expected: ExpectedNode = {
      block: 'core/video',
      attrs: {
        src: 'demo.mp4',
        poster: 'poster.jpg',
        controls: true,
        caption: { $oneOf: ['Demo', 'Preview'] },
        preload: 'metadata',
      },
    };
    const produced: WpBlock = {
      name: 'core/video',
      // Gutenberg parses rich-text strings into an object with this JSON representation.
      attributes: { src: 'demo.mp4', poster: 'poster.jpg', controls: true, caption: { toJSON: () => 'Demo' } },
      innerBlocks: [],
    };
    const tally: Tally = {
      structureTotal: 0,
      structureMatched: 0,
      contentTotal: 0,
      contentMatched: 0,
      misses: [],
    };

    matchNode(expected, [produced], tally, 'fixture');

    expect(tally.structureMatched).toBe(1);
    expect(tally.contentTotal).toBe(5);
    expect(tally.contentMatched).toBe(4);
    expect(tally.misses).toEqual([expect.stringContaining('preload="metadata"')]);
  });

  it('accepts a reviewed whole-tree equivalent without weakening the canonical tree', async () => {
    const canonical: ExpectedNode = {
      block: 'core/group',
      children: [{ block: 'core/heading', contains: 'Download' }],
    };
    const alternative: ExpectedNode = {
      block: 'core/group',
      children: [
        {
          block: 'core/group',
          children: [{ block: 'core/heading', contains: 'Download' }],
        },
      ],
    };
    const spec: Spec = {
      layout: 'equivalent',
      intent: '',
      tree: canonical,
      acceptedTrees: [alternative],
      display: expectedToDisplay(canonical),
      acceptedDisplays: [expectedToDisplay(alternative)],
    };
    const report = await realize(
      JSON.stringify({
        blocks: [
          {
            block: 'core/group',
            children: [
              { block: 'core/group', children: [{ block: 'core/heading', text: 'Download' }] },
            ],
          },
        ],
      }),
    );

    const result = await scoreReport('any-producer', 'equivalent', spec, '<h2>Download</h2>', report);

    expect(result.valid).toBe(true);
    expect(result.score).toBe(100);
    expect(result.misses).toEqual([]);
  });

  it('accepts either visible file-button label while rejecting an empty label', async () => {
    const spec = loadSpecs().get('file-download')!;
    const intent: IntentTree = {
      blocks: [
        {
          block: 'core/group',
          children: [
            {
              block: 'core/group',
              children: [
                { block: 'core/heading', text: 'Get the spec sheet' },
                { block: 'core/paragraph', text: 'Every supported block, and what it maps from.' },
                {
                  block: 'core/file',
                  attrs: {
                    href: 'block-reference.pdf',
                    fileName: 'Block reference (PDF)',
                    showDownloadButton: true,
                    downloadButtonText: 'Block reference (PDF)',
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const report = await realize(JSON.stringify(intent));
    const result = await scoreReport(
      'any-producer',
      'file-download',
      spec,
      '<h2>Get the spec sheet</h2><p>Every supported block, and what it maps from.</p>',
      report,
    );

    expect(result.score).toBe(100);

    const emptyIntent = structuredClone(intent);
    emptyIntent.blocks[0]!.children![0]!.children![2]!.attrs!.downloadButtonText = '';
    const emptyReport = await realize(JSON.stringify(emptyIntent));
    const emptyResult = await scoreReport(
      'any-producer',
      'file-download',
      spec,
      '<h2>Get the spec sheet</h2><p>Every supported block, and what it maps from.</p>',
      emptyReport,
    );
    expect(emptyResult.score).toBeLessThan(100);
    expect(emptyResult.misses).toEqual([expect.stringContaining('downloadButtonText')]);
  });

  it('keeps every expected block registered and present in every model-facing contract', async () => {
    const specs = loadSpecs();
    const wp = await getWp();
    const guide = readFileSync(path.join(ROOT, 'skills', 'block-runner', 'references', 'GUIDE.md'), 'utf8');
    const blocks = new Set<string>();
    for (const spec of specs.values()) {
      for (const tree of allTrees(spec)) walk(tree, (node) => blocks.add(node.block));
    }

    for (const block of blocks) {
      expect(wp.getBlockType(block), `${block} must be registered`).toBeTruthy();
      expect(CONVERT_PROMPT, `${block} missing from direct prompt`).toContain(block);
      expect(INTENT_PROMPT, `${block} missing from intent prompt`).toContain(block);
      expect(guide, `${block} missing from shipped guide`).toContain(block);
    }
  });

  it('pins the declared WordPress target to the installed block runtime', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    expect(WORDPRESS_TARGET).toBe('7.1');
    expect(gutenbergVersion()).toBe('10.5.0');
    expect(pkg.dependencies['@wordpress/block-library']).toBe(gutenbergVersion());
  });

  it('runs model harnesses outside the checkout without write-capable modes', () => {
    const codex = codexExecArgs('gpt-test', 'low');
    const claude = claudePrintArgs('claude-test', 'low');

    const relativeToCheckout = path.relative(ROOT, MODEL_WORKDIR);
    expect(relativeToCheckout === '' || (!relativeToCheckout.startsWith('..') && !path.isAbsolute(relativeToCheckout))).toBe(false);
    expect(codex).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ephemeral', '--ignore-user-config']));
    expect(codex).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(claude).toEqual(expect.arrayContaining(['--safe-mode', '--restricted', '--no-session-persistence', 'dontAsk']));
    expect(claude).not.toContain('bypassPermissions');
  });

  it('asserts the WordPress 7.1 semantics that previously produced false scores', () => {
    const specs = loadSpecs();
    for (const layout of ['accordion', 'faq-accordion', 'faq-rich']) {
      const spec = specs.get(layout)!;
      expect(findNodes(spec, 'core/accordion').length).toBeGreaterThan(0);
      expect(findNodes(spec, 'core/details')).toEqual([]);
      for (const heading of findNodes(spec, 'core/accordion-heading')) {
        expect(heading.attrs?.title).toEqual(expect.any(String));
      }
    }

    const video = findNodes(specs.get('media-video')!, 'core/video')[0];
    expect(video.attrs).toMatchObject({ src: 'product-demo.mp4', poster: 'demo-poster.jpg', controls: true });
    expect(video.attrs?.caption).toEqual(expect.any(String));

    const audio = findNodes(specs.get('media-audio')!, 'core/audio')[0];
    expect(audio.attrs).toMatchObject({ src: 'episode-12.mp3' });
    expect(audio.attrs?.caption).toEqual(expect.any(String));

    const embed = findNodes(specs.get('media-embed')!, 'core/embed')[0];
    expect(embed.attrs).toMatchObject({ allowResponsive: true });
    expect(embed.attrs?.url).toEqual(expect.any(String));
    expect(embed.attrs?.caption).toEqual(expect.any(String));

    for (const file of findNodes(specs.get('file-download')!, 'core/file')) {
      expect(file.attrs).toMatchObject({
        href: 'block-reference.pdf',
        fileName: 'Block reference (PDF)',
        showDownloadButton: true,
        downloadButtonText: { $oneOf: ['Download', 'Block reference (PDF)'] },
      });
    }

    expect(findNodes(specs.get('rich-content')!, 'core/list')[0].attrs).toMatchObject({ ordered: true });
    expect(findNodes(specs.get('feature-rows')!, 'core/media-text').map((node) => node.attrs?.mediaPosition)).toEqual([
      'left',
      'right',
      'left',
    ]);
  });
});
