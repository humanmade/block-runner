import { JSDOM } from 'jsdom';
import { ReportItem, RuleContext, SourceLocation } from '../types.js';

export interface PreparedDom {
  dom: JSDOM;
  cssBackgrounds: Map<string, string>;
  warnings: ReportItem[];
}

export function prepareDom(input: string, sourcePath?: string): PreparedDom {
  const dom = new JSDOM(input, {
    contentType: 'text/html',
    includeNodeLocations: true,
  });
  const warnings: ReportItem[] = [];
  const cssBackgrounds = extractCssBackgrounds(dom.window.document);

  sanitizeDocument(dom, warnings, sourcePath);

  return {
    dom,
    cssBackgrounds,
    warnings,
  };
}

export function sanitizeDocument(dom: JSDOM, warnings: ReportItem[], sourcePath?: string): void {
  const document = dom.window.document;

  for (const node of [...document.querySelectorAll('script, style')]) {
    warnings.push({
      block: 'input',
      status: 'warning',
      reason: `<${node.tagName.toLowerCase()}> stripped from input`,
      source: sourceForNode(dom, node, sourcePath),
    });
    node.remove();
  }

  for (const element of [...document.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) {
        warnings.push({
          block: 'input',
          status: 'warning',
          reason: `event handler attribute stripped: ${attribute.name}`,
          source: sourceForNode(dom, element, sourcePath),
        });
        element.removeAttribute(attribute.name);
      }

      if ((name === 'href' || name === 'src') && /^javascript:/i.test(value)) {
        warnings.push({
          block: 'input',
          status: 'warning',
          reason: `unsafe ${attribute.name} URL stripped`,
          source: sourceForNode(dom, element, sourcePath),
        });
        element.removeAttribute(attribute.name);
      }
    }
  }
}

export function extractCssBackgrounds(document: Document): Map<string, string> {
  const backgrounds = new Map<string, string>();

  for (const style of [...document.querySelectorAll('style')]) {
    const css = style.textContent ?? '';
    const rulePattern = /\.([_a-zA-Z][\w-]*)\s*\{([^}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;

    while ((ruleMatch = rulePattern.exec(css))) {
      const [, className, body] = ruleMatch;
      const bgMatch = /background(?:-image)?\s*:[^;{}]*url\((['"]?)(.*?)\1\)/i.exec(body);
      if (bgMatch?.[2]) {
        backgrounds.set(className, bgMatch[2].trim());
      }
    }
  }

  return backgrounds;
}

export function sourceForNode(dom: JSDOM, node: Node, path?: string): SourceLocation {
  const location = dom.nodeLocation(node);
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;

  return {
    path,
    selector: element ? selectorFor(element) : undefined,
    htmlLine: location?.startLine,
    htmlColumn: location?.startCol,
    offset: location?.startOffset,
  };
}

export function selectorFor(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current.tagName.toLowerCase() !== 'html' && parts.length < 4) {
    const tag = current.tagName.toLowerCase();
    const id = current.id ? `#${current.id}` : '';
    const classes = [...current.classList].slice(0, 2).map((name) => `.${name}`).join('');
    parts.unshift(`${tag}${id}${classes}`);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

export function contextText(node: Node): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function contextHtml(element: Element): string {
  return element.innerHTML.trim();
}

export function getInlineBackgroundUrl(element: Element): string | undefined {
  const style = element.getAttribute('style') ?? '';
  const match = /background(?:-image)?\s*:[^;{}]*url\((['"]?)(.*?)\1\)/i.exec(style);
  return match?.[2]?.trim();
}

export function getCssBackgroundUrl(element: Element, backgrounds: Map<string, string>): string | undefined {
  for (const className of element.classList) {
    const url = backgrounds.get(className);
    if (url) {
      return url;
    }
  }

  return undefined;
}

export function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

export function isWhitespaceText(node: Node): boolean {
  return node.nodeType === 3 && (node.textContent ?? '').trim() === '';
}

export function isCommentNode(node: Node): boolean {
  return node.nodeType === 8;
}

export function isContainerElement(element: Element): boolean {
  return /^(article|aside|div|footer|header|main|section)$/i.test(element.tagName);
}

export function makeContextWarning(
  context: RuleContext,
  reason: string,
  node: Node,
  block?: string,
  rule?: string,
  details?: unknown,
): ReportItem {
  return {
    block,
    status: 'warning',
    reason,
    source: context.sourceFor(node),
    rule,
    details,
  };
}
