import { BlockRunnerConfig, Rule, RuleContext, WpBlock } from '../types.js';
import {
  contextHtml,
  contextText,
  getCssBackgroundUrl,
  getInlineBackgroundUrl,
  isContainerElement,
} from './dom.js';

const BUTTON_TOKENS = ['btn', 'button', 'cta'];
const COLUMN_TOKENS = ['col', 'column', 'cell', 'card', 'panel'];
const COLUMNS_TOKENS = ['row', 'grid', 'columns', 'cols', 'cards'];
const WRAPPER_TOKENS = ['inner', 'content', 'container', 'wrap', 'wrapper', 'in'];

export function defaultRules(config: BlockRunnerConfig): Rule[] {
  const ruleConfig = Array.isArray(config.rules) ? undefined : config.rules;
  const disabled = new Set(ruleConfig?.disabledDefaults ?? []);
  const order = ruleConfig?.order ?? [];
  const rules = [
    coverRule,
    columnsRule,
    buttonsRule,
    buttonRule,
    imageRule,
    headingRule,
    paragraphRule,
    listRule,
    unwrapRule,
    groupRule,
    htmlFallbackRule,
  ].filter((rule) => !disabled.has(rule.id));

  if (order.length === 0) {
    return rules;
  }

  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return [...rules].sort((a, b) => {
    const aIndex = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aIndex === bIndex ? rules.indexOf(a) - rules.indexOf(b) : aIndex - bIndex;
  });
}

const coverRule: Rule = {
  id: 'cover',
  match(node, context) {
    if (!isContainerElement(node)) {
      return { matched: false, reason: 'not a cover-capable container' };
    }
    return findBackground(node, context) ? true : { matched: false, reason: 'no background image signal' };
  },
  async emit(node, context) {
    const background = findBackground(node, context);
    if (!background) {
      return null;
    }

    const skip = new Set<Node>();
    if (background.node && background.node !== node) {
      skip.add(background.node);
    }

    const tagName = node.tagName.toLowerCase();
    const attrs: Record<string, unknown> = {
      url: background.url,
      dimRatio: 0,
      tagName: tagName === 'div' ? undefined : tagName,
      align: 'full',
    };
    removeUndefined(attrs);

    const block = context.wp.createBlock('core/cover', attrs, await context.recurse(node, skip));
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const columnsRule: Rule = {
  id: 'columns',
  match(node) {
    if (!isContainerElement(node)) {
      return { matched: false, reason: 'not a container' };
    }
    const cells = columnCells(node);
    if (cells.length < 2) {
      return { matched: false, reason: 'fewer than two column-like children' };
    }
    return true;
  },
  async emit(node, context) {
    const columns = await Promise.all(
      columnCells(node).map(async (cell) => {
        const block = context.wp.createBlock('core/column', {}, await context.recurse(cell));
        block.__blockRunnerSource = context.sourceFor(cell);
        return block;
      }),
    );
    const block = context.wp.createBlock('core/columns', { isStackedOnMobile: true }, columns);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const buttonsRule: Rule = {
  id: 'buttons',
  match(node) {
    const anchors = directAnchors(node);
    const classSignal = hasClassToken(node.className, ['buttons', 'button', 'cta', 'actions']);
    return anchors.length > 1 || (classSignal && anchors.length > 0)
      ? true
      : { matched: false, reason: 'not a button group' };
  },
  async emit(node, context) {
    const buttons = directAnchors(node).map((anchor) => emitButton(anchor, context));
    const block = context.wp.createBlock('core/buttons', {}, buttons);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const buttonRule: Rule = {
  id: 'button',
  match(node) {
    if (node.tagName.toLowerCase() !== 'a') {
      return { matched: false, reason: 'not an anchor' };
    }
    return hasClassToken(node.className, BUTTON_TOKENS) || node.getAttribute('role') === 'button'
      ? true
      : { matched: false, reason: 'anchor lacks button signal' };
  },
  async emit(node, context) {
    const button = emitButton(node as HTMLAnchorElement, context);
    const buttons = context.wp.createBlock('core/buttons', {}, [button]);
    buttons.__blockRunnerSource = context.sourceFor(node);
    return buttons;
  },
};

const imageRule: Rule = {
  id: 'image',
  match(node) {
    if (node.tagName.toLowerCase() === 'img') {
      return true;
    }
    return node.tagName.toLowerCase() === 'figure' && node.querySelector(':scope > img')
      ? true
      : { matched: false, reason: 'not an image or figure image' };
  },
  async emit(node, context) {
    const image = node.tagName.toLowerCase() === 'img' ? (node as HTMLImageElement) : node.querySelector('img');
    if (!image) {
      return null;
    }
    const caption = node.tagName.toLowerCase() === 'figure' ? node.querySelector('figcaption')?.innerHTML.trim() : undefined;
    const attrs: Record<string, unknown> = {
      url: image.getAttribute('src') ?? '',
      alt: image.getAttribute('alt') ?? '',
      caption,
    };
    removeUndefined(attrs);
    const block = context.wp.createBlock('core/image', attrs, []);
    block.__blockRunnerSource = context.sourceFor(image);
    return block;
  },
};

const headingRule: Rule = {
  id: 'heading',
  match(node) {
    return /^h[1-6]$/i.test(node.tagName) ? true : { matched: false, reason: 'not a heading' };
  },
  async emit(node, context) {
    const level = Number(node.tagName.slice(1));
    const block = context.wp.createBlock('core/heading', { level, content: contextHtml(node) }, []);
    block.__blockRunnerSource = context.sourceFor(node);
    warnShortcode(node, context, 'core/heading', 'heading');
    return block;
  },
};

const paragraphRule: Rule = {
  id: 'paragraph',
  match(node) {
    return node.tagName.toLowerCase() === 'p' ? true : { matched: false, reason: 'not a paragraph' };
  },
  async emit(node, context) {
    const block = context.wp.createBlock('core/paragraph', { content: contextHtml(node) }, []);
    block.__blockRunnerSource = context.sourceFor(node);
    warnShortcode(node, context, 'core/paragraph', 'paragraph');
    return block;
  },
};

const listRule: Rule = {
  id: 'list',
  match(node) {
    return /^(ul|ol)$/i.test(node.tagName) ? true : { matched: false, reason: 'not a list' };
  },
  async emit(node, context) {
    return emitListBlock(node, context);
  },
};

const unwrapRule: Rule = {
  id: 'unwrap',
  match(node) {
    if (!isContainerElement(node)) {
      return { matched: false, reason: 'not a wrapper container' };
    }
    return hasClassToken(node.className, WRAPPER_TOKENS)
      ? true
      : { matched: false, reason: 'not an inner wrapper' };
  },
  async emit(node, context) {
    return context.recurse(node);
  },
};

const groupRule: Rule = {
  id: 'group',
  match(node) {
    if (!isContainerElement(node)) {
      return { matched: false, reason: 'not a generic container' };
    }
    const hasUsefulChildren = [...node.childNodes].some((child) => contextText(child).length > 0);
    return hasUsefulChildren ? true : { matched: false, reason: 'empty container' };
  },
  async emit(node, context) {
    const tagName = node.tagName.toLowerCase();
    const attrs: Record<string, unknown> = {
      tagName: tagName === 'div' ? undefined : tagName,
    };
    removeUndefined(attrs);
    const block = context.wp.createBlock('core/group', attrs, await context.recurse(node));
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const htmlFallbackRule: Rule = {
  id: 'html',
  match() {
    return true;
  },
  async emit(node, context) {
    const reason =
      node.tagName.toLowerCase() === 'iframe'
        ? 'unsupported iframe emitted as Custom HTML fallback'
        : 'unmapped element emitted as Custom HTML fallback';
    context.warn(reason, node, 'core/html', 'html');
    const block = context.wp.createBlock('core/html', { content: node.outerHTML }, []);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

function findBackground(node: Element, context?: RuleContext): { url: string; node?: Element } | undefined {
  const inline = getInlineBackgroundUrl(node);
  if (inline) {
    return { url: inline, node };
  }

  if (context) {
    const css = getCssBackgroundUrl(node, context.cssBackgrounds);
    if (css) {
      return { url: css, node };
    }
  }

  for (const child of [...node.children]) {
    const childInline = getInlineBackgroundUrl(child);
    if (childInline) {
      return { url: childInline, node: child };
    }
    if (context) {
      const childCss = getCssBackgroundUrl(child, context.cssBackgrounds);
      if (childCss) {
        return { url: childCss, node: child };
      }
    }
    if (child.tagName.toLowerCase() === 'img' && likelyDecorativeImage(child)) {
      const src = child.getAttribute('src');
      if (src) {
        return { url: src, node: child };
      }
    }
  }

  return undefined;
}

function likelyDecorativeImage(element: Element): boolean {
  return (
    element.getAttribute('aria-hidden') === 'true' ||
    element.getAttribute('role') === 'presentation' ||
    /\b(bg|background|hero|cover)\b/i.test(element.className)
  );
}

function columnCells(node: Element): Element[] {
  const children = [...node.children].filter((child) => child.tagName.toLowerCase() !== 'style');
  if (children.length < 2) {
    return [];
  }

  const containerSignal = hasClassToken(node.className, COLUMNS_TOKENS);
  const childSignals = children.filter((child) => hasClassToken(child.className, COLUMN_TOKENS)).length;
  return containerSignal || childSignals >= 2 ? children : [];
}

function directAnchors(node: Element): HTMLAnchorElement[] {
  return [...node.children].filter((child): child is HTMLAnchorElement => child.tagName.toLowerCase() === 'a');
}

function emitButton(anchor: HTMLAnchorElement, context: RuleContext): WpBlock {
  const attrs: Record<string, unknown> = {
    url: anchor.getAttribute('href') ?? '',
    text: anchor.innerHTML.trim() || contextText(anchor),
    linkTarget: anchor.getAttribute('target') ?? undefined,
    rel: anchor.getAttribute('rel') ?? undefined,
  };
  removeUndefined(attrs);
  const block = context.wp.createBlock('core/button', attrs, []);
  block.__blockRunnerSource = context.sourceFor(anchor);
  warnShortcode(anchor, context, 'core/button', 'button');
  return block;
}

async function emitListBlock(node: Element, context: RuleContext): Promise<WpBlock> {
  const ordered = node.tagName.toLowerCase() === 'ol';
  const items = await Promise.all(
    [...node.children]
      .filter((child) => child.tagName.toLowerCase() === 'li')
      .map(async (child) => {
        const nestedLists = [...child.children].filter((nested) => /^(ul|ol)$/i.test(nested.tagName));
        const nestedBlocks = await Promise.all(nestedLists.map((nested) => emitListBlock(nested, context)));
        const content = [...child.childNodes]
          .filter((childNode) => !nestedLists.includes(childNode as Element))
          .map((childNode) => (childNode.nodeType === 1 ? (childNode as Element).outerHTML : childNode.textContent ?? ''))
          .join('')
          .trim();
        const item = context.wp.createBlock('core/list-item', { content }, nestedBlocks);
        item.__blockRunnerSource = context.sourceFor(child);
        return item;
      }),
  );
  const block = context.wp.createBlock('core/list', { ordered }, items);
  block.__blockRunnerSource = context.sourceFor(node);
  return block;
}

function warnShortcode(node: Element, context: RuleContext, block: string, rule: string): void {
  if (/\[[A-Za-z][^\]\n]{0,120}\]/.test(contextText(node))) {
    context.warn('shortcode preserved verbatim', node, block, rule);
  }
}

function removeUndefined(attrs: Record<string, unknown>): void {
  for (const key of Object.keys(attrs)) {
    if (attrs[key] === undefined) {
      delete attrs[key];
    }
  }
}

function hasClassToken(className: string, tokens: string[]): boolean {
  const wanted = new Set(tokens.map((token) => token.toLowerCase()));
  return className.split(/\s+/).some((classPart) => {
    const normalized = classPart.toLowerCase();
    if (wanted.has(normalized)) {
      return true;
    }
    const segments = normalized.split(/[-_]+/).filter(Boolean);
    return segments.some((segment) => wanted.has(segment));
  });
}
