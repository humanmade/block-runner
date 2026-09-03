import { JSDOM } from 'jsdom';
import { ReportItem, RuleContext, SourceLocation, SourceSelectorDependency } from '../types.js';
import { effectiveDeclarations } from '../styles/apply.js';
import { extractUrl } from '../styles/declarations.js';
import { Declaration, parseDeclarationBlock, parseInlineStyle, resolvePrecedence } from '../styles/parse.js';

export interface PreparedDom {
  dom: JSDOM;
  cssBackgrounds: Map<string, string>;
  cssClassRules: CssClassRule[];
  warnings: ReportItem[];
}

export function prepareDom(input: string, sourcePath?: string): PreparedDom {
  const dom = new JSDOM(input, {
    contentType: 'text/html',
    includeNodeLocations: true,
  });
  const warnings: ReportItem[] = [];
  // Harvested before sanitizeDocument strips the <style> elements.
  const cssClassRules = extractCssClassRules(dom.window.document);
  const cssBackgrounds = cssBackgroundsFromRules(cssClassRules);

  sanitizeDocument(dom, warnings, sourcePath);

  return {
    dom,
    cssBackgrounds,
    cssClassRules,
    warnings,
  };
}

/**
 * Native blocks cannot retain arbitrary source attributes, and most cannot retain a raw `id`.
 * Registered-block authoring rewrites those selector atoms to marker classes, then marks the
 * matching source elements before conversion so the scoped CSS still selects the same nodes.
 */
export function retainSelectorDependencies(document: Document, dependencies: readonly SourceSelectorDependency[]): void {
  if (dependencies.length === 0) {
    return;
  }

  for (const element of [...document.querySelectorAll('*')]) {
    for (const dependency of dependencies) {
      if (dependency.kind === 'id') {
        if (element.id === dependency.value) {
          element.classList.add(dependency.markerClass);
        }
        continue;
      }
      try {
        if (element.matches(dependency.value)) {
          element.classList.add(dependency.markerClass);
        }
      } catch {
        // The stylesheet scanner will report the associated selector as blocked rather than
        // pretending an invalid attribute selector has a meaningful runtime dependency.
      }
    }
  }
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

      if ((name === 'href' || name === 'src') && isDangerousUrl(value)) {
        warnings.push({
          block: 'input',
          status: 'warning',
          reason: `unsafe ${attribute.name} URL stripped`,
          source: sourceForNode(dom, element, sourcePath),
        });
        element.removeAttribute(attribute.name);
      }

      // An <iframe srcdoc> carries an inline, executable document; if the iframe isn't a
      // recognised embed it lands verbatim in a Custom HTML block, so strip it up front.
      if (name === 'srcdoc' && element.tagName.toLowerCase() === 'iframe') {
        warnings.push({
          block: 'input',
          status: 'warning',
          reason: 'iframe srcdoc stripped',
          source: sourceForNode(dom, element, sourcePath),
        });
        element.removeAttribute(attribute.name);
      }
    }
  }
}

export interface CssClassRule {
  /** The class the rule selects, without the leading dot. */
  className: string;
  /** Raw declarations, precedence unresolved — the caller merges them with inline styles first. */
  declarations: Declaration[];
  /** Unparseable chunks in the rule body, reported rather than dropped. */
  problems: string[];
}

/**
 * Extract single-class rules (`.hero { … }`) from `<style>` elements, in document order.
 *
 * Single-class only, deliberately: those are the rules a design-HTML generator emits, and they are
 * the only ones whose declarations map onto exactly one element with no specificity reasoning.
 * Anything else in the stylesheet is not consumed — the `<style> stripped from input` warning
 * already says the sheet is not carried wholesale.
 */
export function extractCssClassRules(document: Document): CssClassRule[] {
  const rules: CssClassRule[] = [];

  for (const style of [...document.querySelectorAll('style')]) {
    // At-rule blocks are dropped whole. Their inner rules are conditional (`@media print`,
    // `@supports`) and applying them unconditionally would style every render with CSS meant for
    // one — and a flat rule scan happily matches rules nested inside them.
    const css = stripAtRuleBlocks(style.textContent ?? '');
    // Split into selector/body pairs, then keep only the ones whose selector is exactly one class.
    // Matching `.name{…}` directly cannot handle consecutive rules (the previous rule's `}` is
    // already consumed) and would also match the `.b` inside a compound selector like `div.a .b`.
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;

    while ((ruleMatch = rulePattern.exec(css))) {
      const [, selector, body] = ruleMatch;
      const single = /^\s*\.([_a-zA-Z][\w-]*)\s*$/.exec(selector);
      if (!single) {
        continue;
      }
      const className = single[1];
      // The index is the rule's position across all stylesheets, so the sidecar can keep two rules
      // sharing a selector as separate rules in their authored positions.
      const { declarations, problems } = parseDeclarationBlock(body, `.${className}`, rules.length);
      if (declarations.length > 0 || problems.length > 0) {
        rules.push({ className, declarations, problems });
      }
    }
  }

  return rules;
}

/**
 * Remove `@media`/`@supports`/`@layer` blocks, brace-balanced so nested rules go with them.
 */
function stripAtRuleBlocks(css: string): string {
  let out = '';
  let index = 0;

  while (index < css.length) {
    if (css[index] !== '@') {
      out += css[index];
      index += 1;
      continue;
    }

    // Skip to the end of the at-rule: either a `;` (e.g. @import) or a balanced block.
    let cursor = index;
    while (cursor < css.length && css[cursor] !== '{' && css[cursor] !== ';') {
      cursor += 1;
    }
    if (cursor >= css.length || css[cursor] === ';') {
      index = cursor + 1;
      continue;
    }

    let depth = 0;
    while (cursor < css.length) {
      if (css[cursor] === '{') {
        depth += 1;
      } else if (css[cursor] === '}') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
      cursor += 1;
    }
    index = cursor;
  }

  return out;
}

/**
 * Background image per class, after resolving the cascade across *every* rule for that class — so
 * the structural rules pick the same image the ledger does.
 *
 * Declarations are concatenated in document order and settled in one pass, matching how the styles
 * layer merges them. Resolving rule-by-rule was wrong: a later, unrelated `.hero { color:red }` has
 * nothing to say about `background-image` and must not clear one set earlier.
 */
export function cssBackgroundsFromRules(rules: CssClassRule[]): Map<string, string> {
  const byClass = new Map<string, Declaration[]>();
  for (const rule of rules) {
    byClass.set(rule.className, [...(byClass.get(rule.className) ?? []), ...rule.declarations]);
  }

  const backgrounds = new Map<string, string>();
  for (const [className, declarations] of byClass) {
    const url = decisiveBackgroundUrl(resolvePrecedence(declarations).declarations);
    if (url) {
      backgrounds.set(className, url);
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

/**
 * The background image an inline style actually declares, after precedence.
 *
 * Parsed rather than regex-matched so the structural rules and the styling ledger agree on what the
 * attribute says. A regex scan takes the first `url(...)` it sees, which builds a Cover from
 * `background-image:url(a.jpg);background:#fff` even though the later shorthand removed that image.
 */
export function getInlineBackgroundUrl(element: Element): string | undefined {
  const style = element.getAttribute('style');
  if (!style?.trim()) {
    return undefined;
  }

  return decisiveBackgroundUrl(parseInlineStyle(style).declarations);
}

/**
 * The background image an element actually ends up with, across **every** source we read.
 *
 * One lookup, not two: resolving inline and class rules separately meant an inline
 * `background-image:none` returned "no image", which then fell through to the class rule and built a
 * Cover from an image the author had removed. It also picked between multiple classes by `classList`
 * order rather than stylesheet order. Merging first and resolving once is the same rule S12 applies
 * within a single attribute, extended across sources.
 */
export function getEffectiveBackgroundUrl(element: Element, classRules?: CssClassRule[]): string | undefined {
  return decisiveBackgroundUrl(effectiveDeclarations(element, classRules).declarations);
}

/**
 * The background image a resolved declaration list actually yields.
 *
 * Both `background` and `background-image` can survive precedence — a longhand does not reset the
 * shorthand — and the one declared LAST owns the background-image component. Taking the first
 * `url()` found would build a Cover from `a.jpg` for
 * `background:url(a.jpg);background-image:url(b.jpg)`, where CSS uses b.jpg. Reading the last
 * relevant declaration also handles `background:url(a.jpg);background-image:none`, which removes the
 * image entirely. Importance outranks source order; among equals, last declared wins.
 */
export function decisiveBackgroundUrl(declarations: Declaration[]): string | undefined {
  const relevant = declarations.filter(
    (declaration) => declaration.property === 'background' || declaration.property === 'background-image',
  );

  const decisive = relevant.filter((declaration) => declaration.important).at(-1) ?? relevant.at(-1);
  return decisive ? extractUrl(decisive.value) : undefined;
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

// Browsers strip ASCII whitespace/control characters out of a URL before resolving its scheme,
// so `java\nscript:alert(1)` still executes. Normalise the same way before matching a scheme.
export function stripUrlControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    // Drop ASCII control chars and spaces (0x00-0x20) and DEL (0x7f).
    if (code > 0x20 && code !== 0x7f) {
      out += ch;
    }
  }
  return out;
}

// Executable/script-bearing URL schemes that must never survive into output.
export function isDangerousUrl(value: string): boolean {
  return /^(?:javascript|vbscript):/i.test(stripUrlControlChars(value));
}

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// SVG and MathML elements expose `className` as a namespaced object (SVGAnimatedString),
// not a string, and match none of the HTML rules. Detect them so the walker can route
// them straight to Custom HTML before any rule that assumes an HTMLElement runs.
export function isForeignElement(element: Element): boolean {
  const ns = element.namespaceURI;
  return ns != null && ns !== XHTML_NAMESPACE;
}

// Safe class-attribute read that works for HTML, SVG, and MathML elements alike
// (`element.className` is a string only on HTMLElement).
export function classOf(element: Element): string {
  return element.getAttribute('class') ?? '';
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
