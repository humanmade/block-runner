import { loadConfig } from '../config/load.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import { finalizeBlocks } from '../convert/finalize.js';
import { getWp } from '../headless/wp.js';
import {
  AssembleOptions,
  BlockRunnerReport,
  HeadlessBootError,
  IntentNode,
  IntentTree,
  ReportItem,
  WpBlock,
  WpModules,
} from '../types.js';

interface ExtractResult {
  parsed: boolean;
  tree: IntentTree;
}

// Pull the intent JSON out of a producer response however it wrapped it: the
// ===INTENT_START/END=== markers, a ```json fence, or the first balanced {...}/[...] span.
export function extractIntent(out: string): IntentTree {
  return extractIntentResult(out).tree;
}

function extractIntentResult(out: string): ExtractResult {
  const marked = out.match(/===INTENT_START===([\s\S]*?)===INTENT_END===/);
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (marked ? marked[1] : fence ? fence[1] : out).trim();
  const json = body.startsWith('{') || body.startsWith('[') ? body : sliceFirstJson(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { parsed: false, tree: { blocks: [] } };
  }
  return { parsed: true, tree: normalizeTree(parsed) };
}

function sliceFirstJson(s: string): string {
  const start = s.search(/[{[]/);
  if (start === -1) return '';
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === open) depth += 1;
    else if (s[i] === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return '';
}

// Accept { blocks: [...] }, a bare array of nodes, or a single root node.
function normalizeTree(parsed: unknown): IntentTree {
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as IntentTree).blocks)) {
    return { blocks: (parsed as IntentTree).blocks };
  }
  if (Array.isArray(parsed)) return { blocks: parsed as IntentNode[] };
  if (parsed && typeof parsed === 'object' && typeof (parsed as IntentNode).block === 'string') {
    return { blocks: [parsed as IntentNode] };
  }
  return { blocks: [] };
}

/**
 * Assemble an intent tree into registered Gutenberg block objects. Every node is created through
 * `createBlock`; this path never authors or injects inner HTML.
 */
export async function assemble(nodes: IntentNode[]): Promise<WpBlock[]> {
  return assembleWithWp(nodes, await getWp());
}

async function assembleWithWp(nodes: IntentNode[], wp: WpModules, intentPath = 'blocks'): Promise<WpBlock[]> {
  if (!Array.isArray(nodes)) throw new Error(`${intentPath}: expected an array of block nodes`);
  const out: WpBlock[] = [];
  for (const [index, node] of nodes.entries()) {
    out.push(await assembleNode(node, wp, `${intentPath}[${index}]`));
  }
  return out;
}

async function assembleNode(node: IntentNode, wp: WpModules, intentPath: string): Promise<WpBlock> {
  if (!node || typeof node.block !== 'string' || !node.block.trim()) {
    throw new Error(`${intentPath}: expected a node with a non-empty block name`);
  }
  const name = node.block;
  const text = node.text;
  const attrs: Record<string, unknown> = { ...(node.attrs ?? {}) };
  const children = await assembleWithWp(node.children === undefined ? [] : node.children, wp, `${intentPath}.children`);

  switch (name) {
    case 'core/heading':
      if (text != null) attrs.content = text;
      attrs.level = node.level ?? attrs.level ?? 2;
      return wp.createBlock(name, attrs, []);

    case 'core/paragraph':
      if (text != null) attrs.content = text;
      return wp.createBlock(name, attrs, []);

    case 'core/list-item':
      if (text != null) attrs.content = text;
      return wp.createBlock(name, attrs, children);

    case 'core/button':
      if (text != null) attrs.text = text;
      if (node.url != null) attrs.url = node.url;
      return wp.createBlock(name, attrs, []);

    case 'core/image':
      if (node.url != null) attrs.url = node.url;
      if (node.alt != null) attrs.alt = node.alt;
      return wp.createBlock(name, attrs, []);

    case 'core/list': {
      let items = children;
      if (items.length === 0 && node.items !== undefined) {
        if (!Array.isArray(node.items)) throw new Error(`${intentPath}.items: expected an array of strings`);
        items = node.items.map((item, index) => {
          if (typeof item !== 'string') throw new Error(`${intentPath}.items[${index}]: expected a string`);
          return wp.createBlock('core/list-item', { content: item }, []);
        });
      }
      return wp.createBlock(name, attrs, items);
    }

    case 'core/quote': {
      if (node.citation != null) attrs.citation = node.citation;
      const body = children;
      if (body.length === 0 && text != null) {
        body.push(wp.createBlock('core/paragraph', { content: text }, []));
      }
      return wp.createBlock(name, attrs, body);
    }

    case 'core/details':
      if (text != null) attrs.summary = text;
      return wp.createBlock(name, attrs, children);

    case 'core/pullquote':
      if (text != null) attrs.value = text;
      if (node.citation != null) attrs.citation = node.citation;
      return wp.createBlock(name, attrs, []);

    case 'core/table': {
      if (node.rows !== undefined && !Array.isArray(node.rows)) {
        throw new Error(`${intentPath}.rows: expected an array of string arrays`);
      }
      if (node.rows && node.rows.length > 0) {
        const toCells = (row: string[], index: number, tag: 'th' | 'td'): { cells: { content: string; tag: string }[] } => {
          if (!Array.isArray(row)) throw new Error(`${intentPath}.rows[${index}]: expected an array of strings`);
          return { cells: row.map((content, cell) => {
            if (typeof content !== 'string') throw new Error(`${intentPath}.rows[${index}][${cell}]: expected a string`);
            return { content, tag };
          }) };
        };
        attrs.head = [toCells(node.rows[0], 0, 'th')];
        attrs.body = node.rows.slice(1).map((row, index) => toCells(row, index + 1, 'td'));
      }
      return wp.createBlock(name, attrs, []);
    }

    case 'core/cover':
      if (node.url != null) attrs.url = node.url;
      return wp.createBlock(name, attrs, children);

    case 'core/media-text':
      if (node.url != null) {
        attrs.mediaUrl = node.url;
        attrs.mediaType = 'image';
      }
      if (node.alt != null) attrs.mediaAlt = node.alt;
      return wp.createBlock(name, attrs, children);

    case 'core/columns':
    case 'core/column':
    case 'core/buttons':
    case 'core/group':
    case 'core/gallery':
      return wp.createBlock(name, attrs, children);

    default:
      if (text != null) attrs.content = text;
      return wp.createBlock(name, attrs, children);
  }
}

/**
 * Consume raw intent JSON, assemble a native block tree, and run the shared media/token/gate tail.
 */
export async function realize(rawIntent: string, options: AssembleOptions = {}): Promise<BlockRunnerReport> {
  const extracted = extractIntentResult(rawIntent);
  if (!extracted.parsed) {
    return invalidInputReport('could not parse intent JSON', options);
  }
  if (extracted.tree.blocks.length === 0) {
    return invalidInputReport('intent parsed but contained no blocks', options);
  }

  try {
    const config = await loadConfig(options);
    const wp = await getWp();
    const blocks = await assembleWithWp(extracted.tree.blocks, wp);
    const warnings = unknownBlockWarnings(extracted.tree.blocks, wp, options.sourcePath);
    if (config.styling !== DEFAULT_CONFIG.styling) {
      warnings.push({
        block: 'input',
        status: 'warning',
        reason: `styling ${JSON.stringify(config.styling)} does not apply to intent trees; use convert for authored HTML styling`,
        source: options.sourcePath ? { path: options.sourcePath } : undefined,
      });
    }
    if (blocks.length === 0) {
      return invalidInputReport('intent parsed but contained no blocks', options);
    }
    return finalizeBlocks(blocks, options, config, wp, {
      command: 'assemble',
      warnings,
    });
  } catch (error) {
    if (error instanceof HeadlessBootError || (error instanceof Error && error.name === 'HeadlessBootError')) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return invalidInputReport(`assembly failed: ${message}`, options);
  }
}

function invalidInputReport(reason: string, options: AssembleOptions): BlockRunnerReport {
  return {
    ok: false,
    command: 'assemble',
    summary: { blocks: 0, valid: 0, invalid: 1, warnings: 0 },
    items: [
      {
        block: 'input',
        status: 'invalid',
        reason,
        source: options.sourcePath ? { path: options.sourcePath } : undefined,
      },
    ],
    output: '',
  };
}

function unknownBlockWarnings(nodes: IntentNode[], wp: WpModules, sourcePath?: string): ReportItem[] {
  const warnings: ReportItem[] = [];

  const visit = (node: IntentNode, intentPath: string): void => {
    if (node && typeof node.block === 'string' && !wp.getBlockType(node.block)) {
      warnings.push({
        block: node.block,
        status: 'warning',
        reason: 'block type is not registered',
        source: sourcePath ? { path: sourcePath } : undefined,
        details: { intentPath },
      });
    }
    for (const [index, child] of (node?.children ?? []).entries()) {
      visit(child, `${intentPath}.children[${index}]`);
    }
  };

  for (const [index, node] of nodes.entries()) {
    visit(node, `blocks[${index}]`);
  }
  return warnings;
}
