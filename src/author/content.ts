import { JSDOM } from 'jsdom';
import { bootHeadlessWordPressSync, withMutedWordPressConsole } from '../headless/env.js';
import type { WpBlock } from '../types.js';

const IGNORED_ELEMENTS = new Set(['script', 'style', 'template', 'head']);
const BLOCK_ELEMENTS = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'figcaption', 'figure', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'main', 'nav', 'ol', 'p', 'section', 'table', 'td', 'th', 'ul']);

/** Prove that a supplied native structure still fulfils the authored visible-content contract. */
export function validateSourceContent(sourceHtml: string, compiledTemplate: readonly unknown[]): void {
  const source = new JSDOM(sourceHtml);
  let generated: JSDOM | undefined;
  try {
    generated = new JSDOM(serializeCompiledTemplate(compiledTemplate));
    const sourceContent = contentFacts(source.window.document);
    const generatedContent = contentFacts(generated.window.document);
    assertEqual('visible text sequence', sourceContent.text, generatedContent.text);
    assertEqual('links', sourceContent.links, generatedContent.links);
    assertEqual('image alt text', sourceContent.imageAlts, generatedContent.imageAlts);
  } finally {
    source.window.close();
    generated?.window.close();
  }
}

function serializeCompiledTemplate(template: readonly unknown[]): string {
  const wp = bootHeadlessWordPressSync();
  const toBlock = (node: unknown): WpBlock => {
    if (!Array.isArray(node) || typeof node[0] !== 'string' || !node[1] || typeof node[1] !== 'object' || Array.isArray(node[1])) {
      throw new Error('Compiled native template has an invalid node.');
    }
    return wp.createBlock(node[0], node[1] as Record<string, unknown>, Array.isArray(node[2]) ? node[2].map(toBlock) : []) as WpBlock;
  };
  return withMutedWordPressConsole(() => wp.serialize(template.map(toBlock)));
}

function contentFacts(document: Document): { text: string; links: string[]; imageAlts: string[] } {
  const text = normalizeVisibleText(document.body);
  const links = [...document.querySelectorAll('a')]
    .filter((element) => !element.closest('script,style,template,head'))
    .map((element) => `${normalizeVisibleText(element)} → ${element.getAttribute('href') ?? ''}`);
  const imageAlts = [...document.querySelectorAll('img')]
    .filter((element) => !element.closest('script,style,template,head'))
    .map((element) => element.getAttribute('alt') ?? '');
  return { text, links, imageAlts };
}

function normalizeVisibleText(root: Node): string {
  let value = '';
  const walk = (node: Node): void => {
    if (node.nodeType === node.TEXT_NODE) {
      value += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return;
    const element = node as Element;
    if (IGNORED_ELEMENTS.has(element.tagName.toLowerCase())) return;
    for (const child of element.childNodes) walk(child);
    if (BLOCK_ELEMENTS.has(element.tagName.toLowerCase())) value += ' ';
  };
  walk(root);
  return value.replace(/\s+/g, ' ').trim();
}

function assertEqual(label: string, source: string | readonly string[], generated: string | readonly string[]): void {
  if (JSON.stringify(source) !== JSON.stringify(generated)) {
    throw new Error(`Source content fulfillment failed: ${label} changed; source=${JSON.stringify(source)} compiled=${JSON.stringify(generated)}`);
  }
}
