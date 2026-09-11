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
    assertEqual('image captions', sourceContent.imageCaptions, generatedContent.imageCaptions);
    assertLocalFragmentTargets(sourceContent.localFragmentTargets, generatedContent.localFragmentTargets);
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

function contentFacts(document: Document): { text: string; links: string[]; imageAlts: string[]; imageCaptions: string[]; localFragmentTargets: Map<string, number> } {
  const text = normalizeVisibleText(document.body);
  const links = [...document.querySelectorAll('a')]
    .filter((element) => !element.closest('script,style,template,head'))
    .map((element) => `${normalizeVisibleText(element)} → ${element.getAttribute('href') ?? ''} | target=${element.getAttribute('target') ?? ''} | rel=${element.getAttribute('rel') ?? ''}`);
  const imageAlts = [...document.querySelectorAll('img')]
    .filter((element) => !element.closest('script,style,template,head'))
    .map((element) => element.getAttribute('alt') ?? '');
  const imageCaptions = [...document.querySelectorAll('figure')]
    .filter((element) => element.querySelector('img') && element.querySelector('figcaption'))
    .map((element) => normalizeVisibleText(element.querySelector('figcaption')!));
  const ids = new Map<string, number>();
  for (const element of document.querySelectorAll('[id]')) {
    if (!element.id) continue;
    ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
  }
  const localFragmentTargets = new Map<string, number>();
  for (const link of document.querySelectorAll('a[href]')) {
    if (link.closest('script,style,template,head')) continue;
    const target = decodeLocalFragment(link.getAttribute('href') ?? '');
    if (target && ids.has(target)) localFragmentTargets.set(target, ids.get(target)!);
  }
  return { text, links, imageAlts, imageCaptions, localFragmentTargets };
}

function decodeLocalFragment(href: string): string | undefined {
  if (!href.startsWith('#') || href === '#') return undefined;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

function assertLocalFragmentTargets(source: ReadonlyMap<string, number>, generated: ReadonlyMap<string, number>): void {
  for (const [target, sourceCount] of source) {
    if (sourceCount !== 1) {
      throw new Error(`Source content fulfillment failed: local fragment target ${JSON.stringify(target)} is ambiguous in source`);
    }
    const generatedCount = generated.get(target) ?? 0;
    if (generatedCount !== 1) {
      throw new Error(`Source content fulfillment failed: local fragment target ${JSON.stringify(target)} was lost or became ambiguous; source=1 compiled=${generatedCount}`);
    }
  }
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
