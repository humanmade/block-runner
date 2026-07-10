import { BlockRunnerConfig, Rule, RuleContext, WpBlock } from '../types.js';
import {
  classOf,
  contextText,
  getCssBackgroundUrl,
  getInlineBackgroundUrl,
  isContainerElement,
  isForeignElement,
} from './dom.js';
import { RichTextCheck, cleanRichText, richTextSafe } from './richtext.js';

const LIST_STRUCTURAL = new Set(['ul', 'ol', 'li']);

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
    figureRule,
    headingRule,
    paragraphRule,
    listRule,
    tableRule,
    quoteRule,
    codeRule,
    separatorRule,
    videoRule,
    audioRule,
    detailsRule,
    embedRule,
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
    const classSignal = hasClassToken(node, ['buttons', 'button', 'cta', 'actions']);
    return anchors.length > 1 || (classSignal && anchors.length > 0)
      ? true
      : { matched: false, reason: 'not a button group' };
  },
  async emit(node, context) {
    const anchors = directAnchors(node);
    for (const anchor of anchors) {
      const check = richTextSafe(anchor);
      if (!check.safe) {
        return customHtmlFallback(node, context, check);
      }
    }
    const buttons = anchors.map((anchor) => emitButton(anchor, context));
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
    return hasClassToken(node, BUTTON_TOKENS) || node.getAttribute('role') === 'button'
      ? true
      : { matched: false, reason: 'anchor lacks button signal' };
  },
  async emit(node, context) {
    const check = richTextSafe(node);
    if (!check.safe) {
      return customHtmlFallback(node, context, check);
    }
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
    if (node.tagName.toLowerCase() !== 'figure') {
      return { matched: false, reason: 'not an image or figure' };
    }
    // core/image only claims a figure that is exactly one image (+ optional caption). A figure
    // mixing an image with other content goes to figureRule so nothing is silently dropped.
    const children = [...node.children];
    const images = children.filter((child) => child.tagName.toLowerCase() === 'img');
    const extras = children.filter((child) => !['img', 'figcaption'].includes(child.tagName.toLowerCase()));
    return images.length === 1 && extras.length === 0
      ? true
      : { matched: false, reason: 'not a lone single-image figure' };
  },
  async emit(node, context) {
    const image = node.tagName.toLowerCase() === 'img' ? (node as HTMLImageElement) : node.querySelector('img');
    if (!image) {
      return null;
    }
    const figcaption = node.tagName.toLowerCase() === 'figure' ? node.querySelector('figcaption') : null;
    if (figcaption) {
      const check = richTextSafe(figcaption);
      if (!check.safe) {
        return customHtmlFallback(node, context, check);
      }
    }
    const caption = figcaption ? richTextContent(figcaption, context, 'core/image', 'image') || undefined : undefined;
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

const CAPTIONABLE_BLOCKS = new Set(['core/image', 'core/video', 'core/audio', 'core/table', 'core/embed']);

// A <figure> that isn't a plain image (imageRule claims those first) — dispatch by delegating
// its content to the normal rules, then re-attach the <figcaption> to the single captionable
// block it produced (video/audio/table/embed). Mixed content becomes a group.
const figureRule: Rule = {
  id: 'figure',
  match(node) {
    return node.tagName.toLowerCase() === 'figure' ? true : { matched: false, reason: 'not a figure' };
  },
  async emit(node, context) {
    const figcaption = node.querySelector(':scope > figcaption');
    if (figcaption) {
      const check = richTextSafe(figcaption);
      if (!check.safe) {
        return customHtmlFallback(node, context, check);
      }
    }
    const caption = figcaption ? richTextContent(figcaption, context, 'figure', 'figure') || undefined : undefined;

    // Multiple direct images and nothing else → a gallery (each a core/image). If the figure
    // also holds non-image content, fall through to recurse so that content is preserved too.
    const children = [...node.children];
    const images = children.filter((child) => child.tagName.toLowerCase() === 'img');
    const nonImageContent = children.filter((child) => !['img', 'figcaption'].includes(child.tagName.toLowerCase()));
    if (images.length > 1 && nonImageContent.length === 0) {
      const imageBlocks = images.map((img) => {
        const image = context.wp.createBlock('core/image', {
          url: img.getAttribute('src') ?? '',
          alt: img.getAttribute('alt') ?? '',
        }, []);
        image.__blockRunnerSource = context.sourceFor(img);
        return image;
      });
      const gallery = context.wp.createBlock('core/gallery', caption ? { caption } : {}, imageBlocks);
      gallery.__blockRunnerSource = context.sourceFor(node);
      return gallery;
    }

    const skip = new Set<Node>();
    if (figcaption) {
      skip.add(figcaption);
    }
    const inner = await context.recurse(node, skip);

    if (inner.length === 1) {
      const [block] = inner;
      if (caption && CAPTIONABLE_BLOCKS.has(block.name)) {
        block.attributes.caption = caption;
      } else if (caption) {
        context.warn('figcaption dropped — inner block does not support a caption', figcaption!, block.name, 'figure');
      }
      block.__blockRunnerSource ??= context.sourceFor(node);
      return block;
    }

    // Multiple or no children → a group keeps them together (caption, if any, is not
    // representable on a group, so surface it rather than drop it silently).
    if (caption) {
      context.warn('figcaption dropped — figure has no single captionable block', figcaption!, 'core/group', 'figure');
    }
    const group = context.wp.createBlock('core/group', {}, inner);
    group.__blockRunnerSource = context.sourceFor(node);
    return group;
  },
};

const headingRule: Rule = {
  id: 'heading',
  match(node) {
    return /^h[1-6]$/i.test(node.tagName) ? true : { matched: false, reason: 'not a heading' };
  },
  async emit(node, context) {
    const check = richTextSafe(node);
    if (!check.safe) {
      return customHtmlFallback(node, context, check);
    }
    const level = Number(node.tagName.slice(1));
    const block = context.wp.createBlock('core/heading', { level, content: richTextContent(node, context, 'core/heading', 'heading') }, []);
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
    const check = richTextSafe(node);
    if (!check.safe) {
      return customHtmlFallback(node, context, check);
    }
    const block = context.wp.createBlock('core/paragraph', { content: richTextContent(node, context, 'core/paragraph', 'paragraph') }, []);
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
    const check = richTextSafe(node, { structural: LIST_STRUCTURAL });
    if (!check.safe) {
      return customHtmlFallback(node, context, check);
    }
    return emitListBlock(node, context);
  },
};

const unwrapRule: Rule = {
  id: 'unwrap',
  match(node) {
    if (!isContainerElement(node)) {
      return { matched: false, reason: 'not a wrapper container' };
    }
    return hasClassToken(node, WRAPPER_TOKENS)
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

const separatorRule: Rule = {
  id: 'separator',
  match(node) {
    return node.tagName.toLowerCase() === 'hr' ? true : { matched: false, reason: 'not an hr' };
  },
  async emit(node, context) {
    const block = context.wp.createBlock('core/separator', {}, []);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const quoteRule: Rule = {
  id: 'quote',
  match(node) {
    return node.tagName.toLowerCase() === 'blockquote' ? true : { matched: false, reason: 'not a blockquote' };
  },
  async emit(node, context) {
    const citeEl = node.querySelector(':scope > cite, :scope > footer');
    let citation: string | undefined;
    if (citeEl) {
      const check = richTextSafe(citeEl);
      if (!check.safe) {
        return customHtmlFallback(node, context, check);
      }
      citation = richTextContent(citeEl, context, 'core/quote', 'quote') || undefined;
    }
    const skip = new Set<Node>();
    if (citeEl) {
      skip.add(citeEl);
    }
    const inner = await context.recurse(node, skip);
    const attrs: Record<string, unknown> = { citation };
    removeUndefined(attrs);
    const block = context.wp.createBlock('core/quote', attrs, inner);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const codeRule: Rule = {
  id: 'code',
  match(node) {
    return node.tagName.toLowerCase() === 'pre' ? true : { matched: false, reason: 'not a pre' };
  },
  async emit(node, context) {
    const codeEl = node.querySelector(':scope > code');
    if (codeEl && node.children.length === 1) {
      // <pre><code> is a code sample — core/code stores already-escaped HTML, so read innerHTML
      // (preserves the authored entities/whitespace byte-for-byte) rather than round-tripping
      // through textContent, which would decode &#169;/&nbsp; into different bytes.
      const block = context.wp.createBlock('core/code', { content: codeEl.innerHTML }, []);
      block.__blockRunnerSource = context.sourceFor(node);
      return block;
    }
    // Bare <pre> keeps its whitespace as RichText in core/preformatted.
    const check = richTextSafe(node);
    if (!check.safe) {
      return customHtmlFallback(node, context, check);
    }
    const block = context.wp.createBlock('core/preformatted', { content: node.innerHTML }, []);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const videoRule: Rule = {
  id: 'video',
  match(node) {
    return node.tagName.toLowerCase() === 'video' ? true : { matched: false, reason: 'not a video' };
  },
  async emit(node, context) {
    const src = directMediaSrc(node);
    if (!src) {
      // Multi-<source> or blob video — core/video can't represent it; keep it verbatim.
      context.warn('video without a direct src emitted as Custom HTML fallback', node, 'core/html', 'video');
      const html = context.wp.createBlock('core/html', { content: node.outerHTML }, []);
      html.__blockRunnerSource = context.sourceFor(node);
      return html;
    }
    const tracks = [...node.querySelectorAll(':scope > track')].map((track) => ({
      src: track.getAttribute('src') ?? '',
      kind: track.getAttribute('kind') ?? 'subtitles',
      srcLang: track.getAttribute('srclang') ?? '',
      label: track.getAttribute('label') ?? '',
    }));
    const attrs: Record<string, unknown> = {
      src,
      poster: node.getAttribute('poster') ?? undefined,
      loop: node.hasAttribute('loop') || undefined,
      autoplay: node.hasAttribute('autoplay') || undefined,
      muted: node.hasAttribute('muted') || undefined,
      tracks: tracks.length > 0 ? tracks : undefined,
    };
    removeUndefined(attrs);
    const block = context.wp.createBlock('core/video', attrs, []);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const audioRule: Rule = {
  id: 'audio',
  match(node) {
    return node.tagName.toLowerCase() === 'audio' ? true : { matched: false, reason: 'not an audio' };
  },
  async emit(node, context) {
    const src = directMediaSrc(node);
    if (!src) {
      context.warn('audio without a direct src emitted as Custom HTML fallback', node, 'core/html', 'audio');
      const html = context.wp.createBlock('core/html', { content: node.outerHTML }, []);
      html.__blockRunnerSource = context.sourceFor(node);
      return html;
    }
    const attrs: Record<string, unknown> = {
      src,
      loop: node.hasAttribute('loop') || undefined,
      autoplay: node.hasAttribute('autoplay') || undefined,
    };
    removeUndefined(attrs);
    const block = context.wp.createBlock('core/audio', attrs, []);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const detailsRule: Rule = {
  id: 'details',
  match(node) {
    return node.tagName.toLowerCase() === 'details' ? true : { matched: false, reason: 'not a details' };
  },
  async emit(node, context) {
    const summaryEl = node.querySelector(':scope > summary');
    let summary: string | undefined;
    if (summaryEl) {
      const check = richTextSafe(summaryEl);
      if (!check.safe) {
        return customHtmlFallback(node, context, check);
      }
      summary = richTextContent(summaryEl, context, 'core/details', 'details') || undefined;
    }
    const skip = new Set<Node>();
    if (summaryEl) {
      skip.add(summaryEl);
    }
    const inner = await context.recurse(node, skip);
    const attrs: Record<string, unknown> = {
      summary,
      showContent: node.hasAttribute('open') || undefined,
    };
    removeUndefined(attrs);
    const block = context.wp.createBlock('core/details', attrs, inner);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const tableRule: Rule = {
  id: 'table',
  match(node) {
    return node.tagName.toLowerCase() === 'table' ? true : { matched: false, reason: 'not a table' };
  },
  async emit(node, context) {
    const head = tableSectionRows(node, 'thead');
    const foot = tableSectionRows(node, 'tfoot');
    // Rows may sit in <tbody> or hang directly off <table>.
    const body = [...node.querySelectorAll(':scope > tbody > tr'), ...node.querySelectorAll(':scope > tr')];

    // A cell holding block content or a nested table isn't RichText-safe → keep the whole
    // table verbatim rather than lose structure (per the attribute-preservation contract).
    for (const rows of [head, body, foot]) {
      const unsafe = unsafeTableCell(rows);
      if (unsafe) {
        return customHtmlFallback(node, context, unsafe);
      }
    }

    const captionEl = node.querySelector(':scope > caption');
    if (captionEl) {
      const check = richTextSafe(captionEl);
      if (!check.safe) {
        return customHtmlFallback(node, context, check);
      }
    }

    const attrs: Record<string, unknown> = {
      head: buildTableRows(head, context),
      body: buildTableRows(body, context),
      foot: buildTableRows(foot, context),
      caption: captionEl ? richTextContent(captionEl, context, 'core/table', 'table') || undefined : undefined,
    };
    removeUndefined(attrs);
    const block = context.wp.createBlock('core/table', attrs, []);
    block.__blockRunnerSource = context.sourceFor(node);
    return block;
  },
};

const embedRule: Rule = {
  id: 'embed',
  match(node) {
    if (node.tagName.toLowerCase() !== 'iframe') {
      return { matched: false, reason: 'not an iframe' };
    }
    return detectEmbed(node.getAttribute('src') ?? '') ? true : { matched: false, reason: 'iframe src is not a known embed provider' };
  },
  async emit(node, context) {
    const embed = detectEmbed(node.getAttribute('src') ?? '');
    if (!embed) {
      return null;
    }
    const block = context.wp.createBlock('core/embed', {
      url: embed.url,
      type: 'video',
      providerNameSlug: embed.provider,
      responsive: true,
      className: 'wp-embed-aspect-16-9 wp-has-aspect-ratio',
    }, []);
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
        : 'unmapped element — no native block, preserved as Custom HTML fallback';
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
    /\b(bg|background|hero|cover)\b/i.test(classOf(element))
  );
}

function columnCells(node: Element): Element[] {
  const children = [...node.children].filter((child) => child.tagName.toLowerCase() !== 'style');
  if (children.length < 2) {
    return [];
  }

  const containerSignal = hasClassToken(node, COLUMNS_TOKENS);
  const childSignals = children.filter((child) => hasClassToken(child, COLUMN_TOKENS)).length;
  return containerSignal || childSignals >= 2 ? children : [];
}

function directAnchors(node: Element): HTMLAnchorElement[] {
  return [...node.children].filter(
    (child): child is HTMLAnchorElement => child.tagName.toLowerCase() === 'a' && !isForeignElement(child),
  );
}

function emitButton(anchor: HTMLAnchorElement, context: RuleContext): WpBlock {
  const attrs: Record<string, unknown> = {
    url: anchor.getAttribute('href') ?? '',
    text: richTextContent(anchor, context, 'core/button', 'button') || contextText(anchor),
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
        // Clean the item's inline content (minus nested lists) so RichText normalization can't
        // invalidate it (see cleanRichText); nested lists stay as child blocks.
        const clone = child.cloneNode(true) as Element;
        for (const nested of [...clone.children]) {
          if (/^(ul|ol)$/i.test(nested.tagName)) {
            nested.remove();
          }
        }
        const content = richTextContent(clone, context, 'core/list-item', 'list');
        const item = context.wp.createBlock('core/list-item', { content }, nestedBlocks);
        item.__blockRunnerSource = context.sourceFor(child);
        return item;
      }),
  );
  const block = context.wp.createBlock('core/list', { ordered }, items);
  block.__blockRunnerSource = context.sourceFor(node);
  return block;
}

// When a block's rich text carries content the editor can't hold (SVG/iframe/block-level),
// the whole enclosing unit falls back to Custom HTML — the only outcome where the serialized
// markup, the render, and the editor's post-load state all agree. The warning points at the
// offending inline node so the fix lands in the input (principles #4, #5, #6).
function customHtmlFallback(node: Element, context: RuleContext, check: Extract<RichTextCheck, { safe: false }>): WpBlock {
  context.warn(
    `rich text contains ${check.reason} — enclosing block emitted as Custom HTML fallback`,
    check.offender,
    'core/html',
    'richtext',
  );
  const block = context.wp.createBlock('core/html', { content: node.outerHTML }, []);
  block.__blockRunnerSource = context.sourceFor(node);
  return block;
}

// Extract an element's inner markup as RichText content, stripping the empty decorative inline
// elements Gutenberg would drop on save (see cleanRichText). Warns once when it strips anything.
function richTextContent(element: Element, context: RuleContext, block: string, rule: string): string {
  const { html, stripped } = cleanRichText(element);
  if (stripped) {
    context.warn('empty decorative inline element stripped from rich text', element, block, rule);
  }
  return html;
}

function warnShortcode(node: Element, context: RuleContext, block: string, rule: string): void {
  if (/\[[A-Za-z][^\]\n]{0,120}\]/.test(contextText(node))) {
    context.warn('shortcode preserved verbatim', node, block, rule);
  }
}

function directMediaSrc(node: Element): string | undefined {
  const src = node.getAttribute('src')?.trim();
  return src || undefined;
}

function tableSectionRows(table: Element, section: 'thead' | 'tfoot'): Element[] {
  const el = table.querySelector(`:scope > ${section}`);
  return el ? [...el.querySelectorAll(':scope > tr')] : [];
}

function tableCells(row: Element): Element[] {
  return [...row.children].filter((cell) => /^(td|th)$/i.test(cell.tagName));
}

function unsafeTableCell(rows: Element[]): Extract<RichTextCheck, { safe: false }> | undefined {
  for (const row of rows) {
    for (const cell of tableCells(row)) {
      const check = richTextSafe(cell);
      if (!check.safe) {
        return check;
      }
    }
  }
  return undefined;
}

function buildTableRows(rows: Element[], context: RuleContext): Array<{ cells: Array<Record<string, unknown>> }> {
  return rows.map((row) => ({
    cells: tableCells(row).map((cell) => {
      const attrs: Record<string, unknown> = {
        content: richTextContent(cell, context, 'core/table', 'table'),
        tag: cell.tagName.toLowerCase(),
      };
      const colspan = cell.getAttribute('colspan');
      const rowspan = cell.getAttribute('rowspan');
      const scope = cell.getAttribute('scope');
      if (colspan) attrs.colspan = colspan;
      if (rowspan) attrs.rowspan = rowspan;
      if (scope) attrs.scope = scope;
      return attrs;
    }),
  }));
}

// Detect a known embed provider by parsing the URL and matching an EXACT hostname + anchored
// path shape — never a substring match, so lookalike domains (notyoutube.com, evilvimeo.com)
// can't cross the provider trust boundary.
function detectEmbed(src: string): { provider: string; url: string } | undefined {
  let url: URL;
  try {
    url = new URL(src.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') {
    return undefined;
  }
  const host = url.hostname.toLowerCase();

  if (host === 'www.youtube.com' || host === 'youtube.com') {
    const embed = url.pathname.match(/^\/embed\/([\w-]{11})$/);
    if (embed) {
      return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${embed[1]}` };
    }
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      if (id && /^[\w-]{11}$/.test(id)) {
        return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
      }
    }
  }
  if (host === 'youtu.be') {
    const id = url.pathname.match(/^\/([\w-]{11})$/);
    if (id) {
      return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${id[1]}` };
    }
  }
  if (host === 'player.vimeo.com') {
    const id = url.pathname.match(/^\/video\/(\d+)$/);
    if (id) {
      return { provider: 'vimeo', url: `https://vimeo.com/${id[1]}` };
    }
  }
  if (host === 'vimeo.com') {
    const id = url.pathname.match(/^\/(\d+)$/);
    if (id) {
      return { provider: 'vimeo', url: `https://vimeo.com/${id[1]}` };
    }
  }
  return undefined;
}

function removeUndefined(attrs: Record<string, unknown>): void {
  for (const key of Object.keys(attrs)) {
    if (attrs[key] === undefined) {
      delete attrs[key];
    }
  }
}

function hasClassToken(element: Element, tokens: string[]): boolean {
  const wanted = new Set(tokens.map((token) => token.toLowerCase()));
  return classOf(element).split(/\s+/).some((classPart) => {
    const normalized = classPart.toLowerCase();
    if (wanted.has(normalized)) {
      return true;
    }
    const segments = normalized.split(/[-_]+/).filter(Boolean);
    return segments.some((segment) => wanted.has(segment));
  });
}
