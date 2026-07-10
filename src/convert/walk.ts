import { RuleContext, WpBlock } from '../types.js';
import { contextText, isCommentNode, isElementNode, isForeignElement, isWhitespaceText } from './dom.js';

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

  // Foreign elements (SVG, MathML) match no HTML rule and would crash rules that read a
  // string `className`. Route them straight to Custom HTML so nothing degrades in silence.
  if (isForeignElement(node)) {
    return [emitCustomHtml(node, context, 'foreign element emitted as Custom HTML fallback')];
  }

  for (const rule of context.rules) {
    let matched: boolean;
    let reason: string | undefined;
    try {
      const result = rule.match(node, context);
      matched = typeof result === 'boolean' ? result : result.matched;
      reason = typeof result === 'boolean' ? undefined : result.reason;
    } catch (error) {
      // A throwing rule must never abort the whole run; contain this node atomically.
      return [emitConversionError(node, context, rule.id, error)];
    }

    if (!matched) {
      if (context.explain && reason) {
        context.explainRule(node, rule.id, reason);
      }
      continue;
    }

    let emitted: WpBlock | WpBlock[] | null;
    try {
      emitted = await rule.emit(node, context);
    } catch (error) {
      return [emitConversionError(node, context, rule.id, error)];
    }
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

function emitCustomHtml(node: Element, context: RuleContext, reason: string): WpBlock {
  context.warn(reason, node, 'core/html', 'html');
  const block = context.wp.createBlock('core/html', { content: node.outerHTML }, []);
  block.__blockRunnerSource = context.sourceFor(node);
  return block;
}

function emitConversionError(node: Element, context: RuleContext, ruleId: string, error: unknown): WpBlock {
  const message = error instanceof Error ? error.message : String(error);
  context.warn('conversion error emitted as Custom HTML fallback', node, 'core/html', ruleId, { error: message });
  const block = context.wp.createBlock('core/html', { content: node.outerHTML }, []);
  block.__blockRunnerSource = context.sourceFor(node);
  return block;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
