import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { cleanRichText, richTextSafe } from '../convert/richtext.js';
import type { AuthoringCoverageLocation, AuthoringPlan, AuthoringStructureNode, JsonValue } from '../authoring/schema.js';
import type { AuthoringProposal, AuthoringProposalDecision, AuthoringProposalNode } from '../types.js';
import { validateSourceContent } from './content.js';
import { compileRegisteredBlock } from '../authoring/generate.js';
import { retainSelectorDependencies } from '../convert/dom.js';
import type { SourceSelectorDependency } from '../types.js';

export interface BoundAuthoringProposal extends AuthoringPlan {
  /** Internal only: ties a hash-bound source range to one emitted native node. */
  sourceRefToNode: ReadonlyMap<string, string>;
}

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
  retainedCssClasses?: readonly string[];
  selectorDependencies?: readonly SourceSelectorDependency[];
}): BoundAuthoringProposal {
  const dom = new JSDOM(input.sourceHtml, { includeNodeLocations: true });
  try {
    retainSelectorDependencies(dom.window.document, input.selectorDependencies ?? []);
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
        throw new Error(`${referenceLocation(decision.sourceRef, input.sourceHash, input.sourceHtml, input.sourcePath)}: proposal decision sourceRef ${decision.sourceRef} is stale, missing, or belongs to another source`);
      }
    }
    const explicit = new Map<string, AuthoringProposalDecision>();
    for (const decision of decisions) {
      const key = `${decision.sourceRef}:${decision.node ?? ''}:${decision.attribute ?? ''}`;
      if (explicit.has(key)) throw new Error(`${referenceLocation(decision.sourceRef, input.sourceHash, input.sourceHtml, input.sourcePath)}: duplicate proposal source decision`);
      explicit.set(key, decision);
    }
    const sourceRefToNode = new Map<string, string>();
    const bind = (node: AuthoringProposalNode): AuthoringStructureNode => {
      const attributes: Record<string, JsonValue> = { ...(node.attributes ?? {}) };
      let element: Element | undefined;
      if (node.sourceRef) {
        if (!node.sourceRef.startsWith(`${input.sourceHash}:`)) throw new Error(`${referenceLocation(node.sourceRef, input.sourceHash, input.sourceHtml, input.sourcePath)}: proposal sourceRef ${node.sourceRef} is stale or belongs to another source`);
        element = index.get(node.sourceRef);
        if (!element) throw new Error(`${referenceLocation(node.sourceRef, input.sourceHash, input.sourceHtml, input.sourcePath)}: proposal sourceRef ${node.sourceRef} is missing or ambiguous`);
        if (isSourceUnit(element) && !isCompatibleSourceBinding(element, node.block)) {
          throw new Error(`${describeElement(element, dom, input.sourcePath)}: proposal sourceRef ${node.sourceRef} cannot bind ${element.tagName.toLowerCase()} content to ${node.block}`);
        }
        if (ownsContent(node.block)) {
          const overlapping = [...usedElements.entries()].find(([, candidate]) => candidate === element || candidate.contains(element!) || element!.contains(candidate));
          if (used.has(node.sourceRef) || overlapping) throw new Error(`${describeElement(element, dom, input.sourcePath)}: proposal sourceRef ${node.sourceRef} binds content more than once or overlaps ${overlapping?.[0] ?? node.sourceRef}`);
          used.add(node.sourceRef);
          usedElements.set(node.sourceRef, element);
        }
        const classes = [...element.classList].filter((name) => (input.retainedCssClasses ?? []).includes(name)
          || (input.selectorDependencies ?? []).some((dependency) => dependency.markerClass === name));
        if (classes.length) attributes.className = [...new Set([...(typeof attributes.className === 'string' ? attributes.className.split(/\s+/) : []), ...classes])].filter(Boolean).join(' ');
        sourceRefToNode.set(node.sourceRef, node.id);
        bindContent(node, element, attributes, explicit, node.sourceRef);
      }
      return { id: node.id, block: node.block, ...(Object.keys(attributes).length ? { attributes } : {}), ...(node.lock ? { lock: node.lock } : {}), ...(node.children?.length ? { children: node.children.map(bind) } : {}) };
    };
    const structure = input.proposal.structure.map(bind);
    const nodeIds = new Set(flatten(input.proposal.structure).map((node) => node.id));
    validateDecisions(decisions, index, sourceRefToNode, nodeIds, input, dom);
    return {
      ...input.base,
      structure,
      ...(input.proposal.fields ? { fields: input.proposal.fields } : {}),
      ...(input.proposal.locking ? { locking: input.proposal.locking } : {}),
      ...(input.proposal.allowedBlocks ? { allowedBlocks: input.proposal.allowedBlocks } : {}),
      ...(input.proposal.pattern ? { pattern: input.proposal.pattern } : {}),
      sourceDecisions: decisions.map((decision) => ({ ...decision,
        // An omission of an entire media unit has no one safe scalar original value.  Keep the
        // reviewed source location/ref, while attribute decisions continue to use the alias-aware
        // adapter below for their canonical audit value.
        original: decision.action === 'add' || (decision.action === 'omit' && !decision.node && !decision.attribute)
          ? undefined
          : originalValue(index.get(decision.sourceRef)!, decision.attribute, decision.node ? findProposalNode(input.proposal.structure, decision.node)?.block : undefined),
        source: sourceLocation(index.get(decision.sourceRef), dom, input.sourcePath),
        ...(decision.node ? { node: decision.node } : {}),
      })),
      sourceRefToNode,
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
  for (const [attribute, value] of sourceAttributes(element, node.block)) apply(attribute, value);
}

function safeHtml(element: Element): string { const safe = richTextSafe(element); if (!safe.safe) throw new Error(`source content is not RichText-safe: ${safe.reason}`); return cleanRichText(element).html; }
function ownsContent(block: string): boolean { return ['core/image', 'core/button', 'core/heading', 'core/paragraph', 'core/list-item'].includes(block); }
function sourceLocation(element: Element | undefined, dom: JSDOM, path?: string): AuthoringCoverageLocation | undefined { const loc = element && dom.nodeLocation(element); return loc ? { path, htmlLine: loc.startLine, htmlColumn: loc.startCol, offset: loc.startOffset } : undefined; }
function describeElement(element: Element, dom: JSDOM, path?: string): string { const loc = dom.nodeLocation(element); return `${path ?? '<inline>'}:${loc?.startLine ?? '?'}:${loc?.startCol ?? '?'} (offset ${loc?.startOffset ?? '?'})`; }
function originalValue(element: Element, attribute?: string, block?: string): JsonValue | undefined {
  if (!attribute) return safeHtml(element);
  return sourceAttributes(element, block).get(attribute);
}

/** The sole HTML-to-native alias table used for both execution and audit records. */
function sourceAttributes(element: Element, block?: string): Map<string, JsonValue> {
  const values = new Map<string, JsonValue>();
  if (block === 'core/image') {
    const image = element.matches('figure') ? element.querySelector('img') : element;
    if (image?.getAttribute('src')) values.set('url', image.getAttribute('src')!);
    values.set('alt', image?.getAttribute('alt') ?? '');
    if (image?.getAttribute('title')) values.set('title', image.getAttribute('title')!);
    const caption = element.matches('figure') ? element.querySelector('figcaption') : undefined;
    if (caption) values.set('caption', safeHtml(caption));
  } else if (block === 'core/button') {
    const link = element.matches('a') ? element : element.querySelector('a');
    if (link) {
      values.set('text', safeHtml(link)); values.set('url', link.getAttribute('href') ?? '');
      if (link.getAttribute('target')) values.set('linkTarget', link.getAttribute('target')!);
      if (link.getAttribute('rel')) values.set('rel', link.getAttribute('rel')!);
    }
  } else if (block === 'core/heading' || block === 'core/paragraph' || block === 'core/list-item') {
    values.set('content', safeHtml(element));
    if (block === 'core/heading' && /^h[1-6]$/i.test(element.tagName)) values.set('level', Number(element.tagName.slice(1)));
  }
  return values;
}

function validateDecisions(decisions: readonly AuthoringProposalDecision[], index: ReadonlyMap<string, Element>, bindings: ReadonlyMap<string, string>, nodeIds: ReadonlySet<string>, input: Parameters<typeof bindAuthoringProposal>[0], dom: JSDOM): void {
  for (const decision of decisions) {
    const element = index.get(decision.sourceRef)!;
    const location = describeElement(element, dom, input.sourcePath);
    if (decision.node && !nodeIds.has(decision.node)) throw new Error(`${location}: proposal decision node ${decision.node} does not exist`);
    const boundNode = bindings.get(decision.sourceRef);
    const block = decision.node ? findProposalNode(input.proposal.structure, decision.node)?.block : undefined;
    const supported = block ? sourceAttributes(element, block).has(decision.attribute ?? '') : false;
    if (decision.action === 'replace') {
      if (!decision.node || !decision.attribute || decision.value === undefined || boundNode !== decision.node || !supported) throw new Error(`${location}: replace decision must name its exact bound node, supported source-owned attribute, and value`);
    } else if (decision.action === 'omit') {
      const wholeUnit = !decision.node && !decision.attribute && !boundNode && isSourceUnit(element);
      const boundAttribute = !!decision.node && !!decision.attribute && boundNode === decision.node && supported;
      if (!wholeUnit && !boundAttribute) throw new Error(`${location}: omit decision must name an unbound source unit or an exact bound source-owned attribute`);
    } else {
      // Adds describe proposal-owned material, not the disposition of a source unit.  A
      // sourceRef-bearing decision that cannot affect a bound source attribute is stale audit
      // data and must not become an escape hatch for an unconsumed unit.
      throw new Error(`${location}: add decision does not consume a source-owned attribute`);
    }
  }
}

function findProposalNode(nodes: readonly AuthoringProposalNode[], id: string): AuthoringProposalNode | undefined { for (const node of nodes) { if (node.id === id) return node; const nested = findProposalNode(node.children ?? [], id); if (nested) return nested; } return undefined; }
function isSourceUnit(element: Element): boolean { return element.matches('h1,h2,h3,h4,h5,h6,p,li,figure') || (element.matches('img') && !element.closest('figure')) || (element.matches('a') && !element.closest('h1,h2,h3,h4,h5,h6,p,li')); }
function isCompatibleSourceBinding(element: Element, block: string): boolean {
  if (/^h[1-6]$/i.test(element.tagName)) return block === 'core/heading';
  if (element.matches('p')) return block === 'core/paragraph';
  if (element.matches('li')) return block === 'core/list-item';
  if (element.matches('figure,img')) return block === 'core/image';
  if (element.matches('a')) return block === 'core/button';
  return true;
}
function referenceLocation(ref: string, hash: string, html: string, path?: string): string { const match = new RegExp(`^${hash}:(\\d+)-(\\d+)$`).exec(ref); if (!match) return `${path ?? '<inline>'}: ${ref}`; const offset = Number(match[1]); if (offset < 0 || offset > html.length) return `${path ?? '<inline>'}: invalid source range ${match[1]}-${match[2]}`; const before = html.slice(0, offset); return `${path ?? '<inline>'}:${before.split('\n').length}:${offset - before.lastIndexOf('\n')} (offset ${offset})`; }

/** Proposal callers must either preserve all source content or carry an explicit reviewed change. */
export function validateProposalSourceContent(sourceHtml: string, bound: AuthoringPlan, plan: AuthoringPlan): void {
  const decisions = bound.sourceDecisions ?? [];
  for (const decision of decisions) {
    if (!decision.reason.trim() || !decision.source) throw new Error(`proposal source decision ${decision.sourceRef} is not source-bound`);
  }
  const hash = createHash('sha256').update(sourceHtml, 'utf8').digest('hex');
  const dom = new JSDOM(sourceHtml, { includeNodeLocations: true });
  try {
    const refs = (element: Element) => {
      const loc = dom.nodeLocation(element);
      return loc ? `${hash}:${loc.startOffset}-${loc.endOffset}` : undefined;
    };
    const bindings = 'sourceRefToNode' in bound ? (bound as BoundAuthoringProposal).sourceRefToNode : new Map<string, string>();
    const nodes = new Map(flattenStructure(plan.structure).filter((node): node is AuthoringStructureNode & { id: string } => !!node.id).map((node) => [node.id, node]));
    const byKey = new Map(decisions.map((decision) => [`${decision.sourceRef}:${decision.node ?? ''}:${decision.attribute ?? ''}`, decision]));
    for (const element of [...dom.window.document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,img,figure,a')]) {
      // A parent rich-text node owns its inline links; a figure owns its image/caption pair.
      if (element.matches('a') && element.closest('h1,h2,h3,h4,h5,h6,p,li')) continue;
      if (element.matches('img') && element.closest('figure')) continue;
      const ref = refs(element);
      if (!ref) continue;
      const nodeId = bindings.get(ref);
      const wholeOmission = byKey.get(`${ref}::`)?.action === 'omit';
      if (!nodeId) { if (!wholeOmission) throw new Error(`Source content fulfillment failed: ${ref} was neither consumed nor explicitly omitted.`); continue; }
      const node = nodes.get(nodeId);
      if (!node) throw new Error(`Source content fulfillment failed: ${ref} has no final bound node.`);
      for (const [attribute, original] of sourceAttributes(element, node.block)) {
        const decision = byKey.get(`${ref}:${nodeId}:${attribute}`);
        if (decision?.action === 'omit') continue;
        const expected = decision?.action === 'replace' ? decision.value : original;
        const retainedLocalImage = attribute === 'url' && node.block === 'core/image'
          && plan.coverage?.assets.some((asset) => asset.reference === original && (asset.outcome === 'prepared' || asset.outcome === 'copied'))
          && plan.assets.some((asset) => asset.uses?.some((use) => use.node === nodeId && use.attribute === 'url'));
        if (!retainedLocalImage && JSON.stringify(node.attributes?.[attribute]) !== JSON.stringify(expected)) {
          throw new Error(`Source content fulfillment failed: ${ref} ${attribute} was not preserved by its exact bound node.`);
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
