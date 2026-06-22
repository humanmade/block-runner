import { RuleContext, WpBlock } from '../types.js';
import { contextText, isCommentNode, isElementNode, isWhitespaceText } from './dom.js';

export async function walkChildren(parent: Node, context: RuleContext, skip = new Set<Node>()): Promise<WpBlock[]> {
  const blocks: WpBlock[] = [];

  for (const child of [...parent.childNodes]) {
    if (skip.has(child)) {
      continue;
    }
    blocks.push(...(await walkNode(child, context)));
  }

  return blocks;
}

export async function walkNode(node: Node, context: RuleContext): Promise<WpBlock[]> {
  if (isWhitespaceText(node) || isCommentNode(node)) {
    return [];
  }

  if (!isElementNode(node)) {
    const text = contextText(node);
    if (!text) {
      return [];
    }
    const paragraph = context.wp.createBlock('core/paragraph', { content: escapeHtml(text) }, []);
    paragraph.__blockRunnerSource = context.sourceFor(node);
    return [paragraph];
  }

  for (const rule of context.rules) {
    const result = rule.match(node, context);
    const matched = typeof result === 'boolean' ? result : result.matched;

    if (!matched) {
      if (context.explain && typeof result !== 'boolean' && result.reason) {
        context.explainRule(node, rule.id, result.reason);
      }
      continue;
    }

    const emitted = await rule.emit(node, context);
    if (!emitted) {
      return [];
    }

    const blocks = Array.isArray(emitted) ? emitted : [emitted];
    for (const block of blocks) {
      block.__blockRunnerSource ??= context.sourceFor(node);
    }
    if (context.explain) {
      context.explainRule(node, rule.id, 'matched');
    }
    return blocks;
  }

  return [];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
