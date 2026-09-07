import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { cleanRichText, richTextSafe } from '../convert/richtext.js';
import type { AuthoringCoverageLocation, AuthoringPlan, AuthoringStructureNode, JsonValue } from '../authoring/schema.js';
import type { AuthoringProposal, AuthoringProposalDecision, AuthoringProposalNode } from '../types.js';
import { validateSourceContent } from './content.js';
import { compileRegisteredBlock } from '../authoring/generate.js';

/** Normalize the deliberately small model-facing proposal before it reaches canonical authoring. */
export function normalizeAuthoringProposal(input: unknown): AuthoringProposal {
  const root = record(input, 'proposal');
  keys(root, ['structure', 'fields', 'locking', 'allowedBlocks', 'pattern', 'sourceDecisions'], 'proposal');
  if (!Array.isArray(root.structure)) throw new Error('proposal.structure must be an array');
  const structure = root.structure.map((node, index) => normalizeNode(node, `proposal.structure[${index}]`));
  const ids = flatten(structure).map((node) => node.id);
  if (new Set(ids).size !== ids.length) throw new Error('proposal structure node ids must be unique');
  const decisions = root.sourceDecisions === undefined ? [] : array(root.sourceDecisions, 'proposal.sourceDecisions').map((decision, index) => normalizeDecision(decision, `proposal.sourceDecisions[${index}]`));
  return {
    structure,
    ...(root.fields === undefined ? {} : { fields: root.fields as AuthoringProposal['fields'] }),
    ...(root.locking === undefined ? {} : { locking: root.locking as AuthoringProposal['locking'] }),
    ...(root.allowedBlocks === undefined ? {} : { allowedBlocks: array(root.allowedBlocks, 'proposal.allowedBlocks').map((value) => string(value, 'proposal.allowedBlocks[]')) }),
    ...(root.pattern === undefined ? {} : { pattern: root.pattern as AuthoringProposal['pattern'] }),
    ...(decisions.length ? { sourceDecisions: decisions } : {}),
  };
}

/** Bind proposal references to the exact DOM parsed from this source hash. */
export function bindAuthoringProposal(input: {
  proposal: AuthoringProposal;
  sourceHtml: string;
  sourceHash: string;
  sourcePath?: string;
  base: AuthoringPlan;
}): AuthoringPlan {
  const dom = new JSDOM(input.sourceHtml, { includeNodeLocations: true });
  try {
    const index = new Map<string, Element>();
    for (const element of [...dom.window.document.querySelectorAll('*')]) {
      const location = dom.nodeLocation(element);
      if (location) index.set(`${input.sourceHash}:${location.startOffset}-${location.endOffset}`, element);
    }
    const used = new Set<string>();
    const usedElements = new Map<string, Element>();
    const decisions = input.proposal.sourceDecisions ?? [];
    for (const decision of decisions) {
      if (!decision.sourceRef.startsWith(`${input.sourceHash}:`) || !index.has(decision.sourceRef)) {
        throw new Error(`${input.sourcePath ?? '<inline>'}: proposal decision sourceRef ${decision.sourceRef} is stale, missing, or belongs to another source`);
      }
    }
    const explicit = new Map(decisions.map((decision) => [`${decision.sourceRef}:${decision.node ?? ''}:${decision.attribute ?? ''}`, decision]));
    const bind = (node: AuthoringProposalNode): AuthoringStructureNode => {
      const attributes: Record<string, JsonValue> = { ...(node.attributes ?? {}) };
      let element: Element | undefined;
      if (node.sourceRef) {
        if (!node.sourceRef.startsWith(`${input.sourceHash}:`)) throw new Error(`${input.sourcePath ?? '<inline>'}: proposal sourceRef ${node.sourceRef} is stale or belongs to another source`);
        element = index.get(node.sourceRef);
        if (!element) throw new Error(`${input.sourcePath ?? '<inline>'}: proposal sourceRef ${node.sourceRef} is missing or ambiguous`);
        if (ownsContent(node.block)) {
          const overlapping = [...usedElements.entries()].find(([, candidate]) => candidate === element || candidate.contains(element!) || element!.contains(candidate));
          if (used.has(node.sourceRef) || overlapping) throw new Error(`${describeElement(element, dom, input.sourcePath)}: proposal sourceRef ${node.sourceRef} binds content more than once or overlaps ${overlapping?.[0] ?? node.sourceRef}`);
          used.add(node.sourceRef);
          usedElements.set(node.sourceRef, element);
        }
        bindContent(node, element, attributes, explicit, node.sourceRef);
      }
      return { id: node.id, block: node.block, ...(Object.keys(attributes).length ? { attributes } : {}), ...(node.lock ? { lock: node.lock } : {}), ...(node.children?.length ? { children: node.children.map(bind) } : {}) };
    };
    const structure = input.proposal.structure.map(bind);
    const nodeIds = new Set(flatten(input.proposal.structure).map((node) => node.id));
    for (const decision of decisions) {
      if (decision.node && !nodeIds.has(decision.node)) throw new Error(`${input.sourcePath ?? '<inline>'}: proposal decision node ${decision.node} does not exist`);
    }
    return {
      ...input.base,
      structure,
      ...(input.proposal.fields ? { fields: input.proposal.fields } : {}),
      ...(input.proposal.locking ? { locking: input.proposal.locking } : {}),
      ...(input.proposal.allowedBlocks ? { allowedBlocks: input.proposal.allowedBlocks } : {}),
      ...(input.proposal.pattern ? { pattern: input.proposal.pattern } : {}),
      sourceDecisions: decisions.map((decision) => ({ ...decision,
        original: decision.action === 'add' ? undefined : originalValue(index.get(decision.sourceRef)!, decision.attribute),
        source: sourceLocation(index.get(decision.sourceRef), dom, input.sourcePath),
        ...(decision.node ? { node: decision.node } : {}),
      })),
    };
  } finally { dom.window.close(); }
}

function bindContent(node: AuthoringProposalNode, element: Element, attributes: Record<string, JsonValue>, decisions: Map<string, AuthoringProposalDecision>, ref: string): void {
  const decision = (attribute: string) => decisions.get(`${ref}:${node.id}:${attribute}`) ?? decisions.get(`${ref}::${attribute}`);
  const apply = (attribute: string, value: JsonValue): void => {
    const change = decision(attribute);
    if (change?.action === 'omit') return;
    if (attributes[attribute] !== undefined && JSON.stringify(attributes[attribute]) !== JSON.stringify(value) && !change) throw new Error(`proposal ${node.id}.${attribute} changes source content without an explicit source decision`);
    attributes[attribute] = change?.action === 'replace' || change?.action === 'add' ? change.value! : value;
  };
  if (node.block === 'core/image') {
    const image = element.matches('figure') ? element.querySelector('img') : element;
    const url = image?.getAttribute('src'); if (url) apply('url', url);
    apply('alt', image?.getAttribute('alt') ?? '');
    const title = image?.getAttribute('title'); if (title) apply('title', title);
    const caption = element.matches('figure') ? element.querySelector('figcaption') : undefined;
    if (caption) apply('caption', safeHtml(caption));
    return;
  }
  if (node.block === 'core/button') {
    const link = element.matches('a') ? element : element.querySelector('a');
    if (link) { apply('text', safeHtml(link)); apply('url', link.getAttribute('href') ?? ''); const target = link.getAttribute('target'); if (target) apply('linkTarget', target); const rel = link.getAttribute('rel'); if (rel) apply('rel', rel); }
    return;
  }
  if (node.block === 'core/heading' || node.block === 'core/paragraph' || node.block === 'core/list-item') {
    apply('content', safeHtml(element));
    if (node.block === 'core/heading' && /^h[1-6]$/i.test(element.tagName)) apply('level', Number(element.tagName.slice(1)));
  }
}

function safeHtml(element: Element): string { const safe = richTextSafe(element); if (!safe.safe) throw new Error(`source content is not RichText-safe: ${safe.reason}`); return cleanRichText(element).html; }
function ownsContent(block: string): boolean { return ['core/image', 'core/button', 'core/heading', 'core/paragraph', 'core/list-item'].includes(block); }
function sourceLocation(element: Element | undefined, dom: JSDOM, path?: string): AuthoringCoverageLocation | undefined { const loc = element && dom.nodeLocation(element); return loc ? { path, htmlLine: loc.startLine, htmlColumn: loc.startCol, offset: loc.startOffset } : undefined; }
function describeElement(element: Element, dom: JSDOM, path?: string): string { const loc = dom.nodeLocation(element); return `${path ?? '<inline>'}:${loc?.startLine ?? '?'}:${loc?.startCol ?? '?'} (offset ${loc?.startOffset ?? '?'})`; }
function originalValue(element: Element, attribute?: string): JsonValue | undefined {
  if (!attribute) return safeHtml(element);
  if (attribute === 'content' || attribute === 'text' || attribute === 'caption') return safeHtml(element);
  return element.getAttribute(attribute) ?? undefined;
}

/** Proposal callers must either preserve all source content or carry an explicit reviewed change. */
export function validateProposalSourceContent(sourceHtml: string, bound: AuthoringPlan, plan: AuthoringPlan): void {
  const decisions = bound.sourceDecisions ?? [];
  if (decisions.length === 0) {
    validateSourceContent(sourceHtml, compileRegisteredBlock(plan).template);
    return;
  }
  const byRef = new Map(decisions.map((decision) => [decision.sourceRef, decision]));
  for (const decision of decisions) {
    if (!decision.reason.trim() || !decision.source) throw new Error(`proposal source decision ${decision.sourceRef} is not source-bound`);
  }
  const values = flattenStructure(plan.structure);
  const hash = createHash('sha256').update(sourceHtml, 'utf8').digest('hex');
  const dom = new JSDOM(sourceHtml, { includeNodeLocations: true });
  try {
    const refs = (element: Element) => {
      const loc = dom.nodeLocation(element);
      return loc ? `${hash}:${loc.startOffset}-${loc.endOffset}` : undefined;
    };
    for (const element of [...dom.window.document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,img,figure,a')]) {
      // A parent rich-text node owns its inline links; a figure owns its image/caption pair.
      if (element.matches('a') && element.closest('h1,h2,h3,h4,h5,h6,p,li')) continue;
      if (element.matches('img') && element.closest('figure')) continue;
      const ref = refs(element);
      if (!ref) continue;
      const decision = byRef.get(ref);
      if (decision?.action === 'omit' || decision?.action === 'replace') continue;
      if (element.matches('img,figure')) {
        const image = element.matches('figure') ? element.querySelector('img') : element;
        const alt = image?.getAttribute('alt') ?? '';
        const caption = element.matches('figure') ? element.querySelector('figcaption') : undefined;
        if (!values.some((node) => node.block === 'core/image' && node.attributes?.alt === alt
          && (!caption || node.attributes?.caption === safeHtml(caption)))) {
          throw new Error(`Source content fulfillment failed: ${ref} media/alt/caption was neither consumed nor omitted.`);
        }
      } else if (element.matches('a')) {
        const text = safeHtml(element); const href = element.getAttribute('href') ?? '';
        if (!values.some((node) => node.block === 'core/button' && node.attributes?.text === text && node.attributes?.url === href)) {
          throw new Error(`Source content fulfillment failed: ${ref} link was neither consumed nor omitted.`);
        }
      } else {
        const content = safeHtml(element);
        if (!values.some((node) => (node.block === 'core/heading' || node.block === 'core/paragraph' || node.block === 'core/list-item') && node.attributes?.content === content)) {
          throw new Error(`Source content fulfillment failed: ${ref} visible text was neither consumed nor omitted.`);
        }
      }
    }
  } finally { dom.window.close(); }
}

function flattenStructure(nodes: readonly AuthoringStructureNode[]): AuthoringStructureNode[] {
  return nodes.flatMap((node) => [node, ...flattenStructure(node.children ?? [])]);
}
function normalizeNode(value: unknown, where: string): AuthoringProposalNode { const node = record(value, where); keys(node, ['id', 'block', 'sourceRef', 'attributes', 'lock', 'children'], where); return { id: string(node.id, `${where}.id`), block: string(node.block, `${where}.block`), ...(node.sourceRef === undefined ? {} : { sourceRef: string(node.sourceRef, `${where}.sourceRef`) }), ...(node.attributes === undefined ? {} : { attributes: node.attributes as Record<string, JsonValue> }), ...(node.lock === undefined ? {} : { lock: node.lock as AuthoringProposalNode['lock'] }), ...(node.children === undefined ? {} : { children: array(node.children, `${where}.children`).map((child, i) => normalizeNode(child, `${where}.children[${i}]`)) }) }; }
function normalizeDecision(value: unknown, where: string): AuthoringProposalDecision { const decision = record(value, where); keys(decision, ['action', 'sourceRef', 'node', 'attribute', 'value', 'reason'], where); const action = string(decision.action, `${where}.action`); if (!['add', 'replace', 'omit'].includes(action)) throw new Error(`${where}.action must be add, replace, or omit`); return { action: action as AuthoringProposalDecision['action'], sourceRef: string(decision.sourceRef, `${where}.sourceRef`), ...(decision.node === undefined ? {} : { node: string(decision.node, `${where}.node`) }), ...(decision.attribute === undefined ? {} : { attribute: string(decision.attribute, `${where}.attribute`) }), ...(decision.value === undefined ? {} : { value: decision.value as JsonValue }), reason: string(decision.reason, `${where}.reason`) }; }
function flatten(nodes: readonly AuthoringProposalNode[]): AuthoringProposalNode[] { return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]); }
function record(value: unknown, where: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`); return value as Record<string, unknown>; }
function array(value: unknown, where: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${where} must be an array`); return value; }
function string(value: unknown, where: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} must be a non-empty string`); return value; }
function keys(value: Record<string, unknown>, allowed: string[], where: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${where}.${key} is not part of AuthoringProposal`); }
