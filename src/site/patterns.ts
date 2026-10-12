import { validatePatternOverrideContract, type PatternOverrideBinding } from '../authoring/pattern-overrides.js';
import type { AuthoringTemplate, IntentNode, IntentTree, ReportItem } from '../types.js';
import { patternOverrideContent } from '../authoring/pattern-overrides.js';
import type { CompiledSiteSyncedPattern, SiteAssetUse, SiteIntent, SiteSyncedPatternUse } from './types.js';

export type CompiledSyncedPattern = CompiledSiteSyncedPattern;

/** Compile database-owned definitions in dependency order, binding only supplied destination IDs. */
export async function compileSyncedPatterns(
  intent: SiteIntent,
  bindings: Readonly<Record<string, number>> = {},
  prepareBody?: (body: IntentTree, documentId: string) => ReportItem[],
  pendingAssets?: (documentId: string) => SiteAssetUse[],
  finalizeBody?: (body: IntentTree, documentId: string) => Promise<{ content?: string; diagnostics: ReportItem[]; ok: boolean }>,
): Promise<CompiledSyncedPattern[]> {
  const extension = intent.syncedPatterns;
  if (!extension) return [];
  const order = syncedPatternOrder(intent);
  const output: CompiledSyncedPattern[] = [];
  for (const id of order) {
    const definition = extension.definitions[id]!;
    const body = structuredClone(definition.body);
    const diagnostics: CompiledSyncedPattern['diagnostics'] = [];
    const template = asAuthoringTemplate(body.blocks);
    const contract = validatePatternOverrideContract(template, []);
    for (const reason of contract.errors) diagnostics.push({ status: 'invalid', code: 'pattern-override-contract', reason, source: { path: `synced-pattern:${id}` } });
    const pendingUses = extension.uses.filter((use) => use.documentId === `synced-pattern:${id}` && !bindings[use.patternId]);
    const pendingBindings = pendingAssets?.(`synced-pattern:${id}`) ?? [];
    for (const use of extension.uses.filter((candidate) => candidate.documentId === `synced-pattern:${id}`)) {
      const node = nodeAtPath(body, use.nodePath);
      if (!node) continue;
      const target = bindings[use.patternId];
      if (target) node.attrs = { ...(node.attrs ?? {}), ref: target, ...(use.content ? { content: patternOverrideContent(use.content) } : {}) };
    }
    diagnostics.push(...(prepareBody?.(body, `synced-pattern:${id}`) ?? []));
    let content: string | undefined;
    let ok = !diagnostics.some((item) => item.status === 'invalid');
    if (!diagnostics.some((item) => item.status === 'invalid') && pendingUses.length === 0 && pendingBindings.length === 0) {
      const result = await finalizeBody?.(body, `synced-pattern:${id}`);
      diagnostics.push(...(result?.diagnostics ?? []));
      if (!result?.ok || result.content === undefined) {
        diagnostics.push({ status: 'invalid', code: 'pattern-finalization-failed', reason: 'synced pattern definition failed native finalization', source: { path: `site://${intent.siteId}/synced-pattern:${id}` } });
        ok = false;
      } else content = result.content;
    }
    ok = ok && !diagnostics.some((item) => item.status === 'invalid');
    output.push({ id, title: definition.title, ...(content !== undefined ? { content } : {}), body, pendingUses, pendingBindings, diagnostics, ok });
  }
  return output;
}

/** Topological order is stable among independent definitions and retains caller identity. */
export function syncedPatternOrder(intent: SiteIntent): string[] {
  const extension = intent.syncedPatterns;
  if (!extension) return [];
  const graph = new Map(Object.keys(extension.definitions).map((id) => [id, new Set<string>()]));
  for (const use of extension.uses) {
    if (!use.documentId.startsWith('synced-pattern:')) continue;
    const owner = use.documentId.slice('synced-pattern:'.length);
    if (graph.has(owner) && graph.has(use.patternId)) graph.get(owner)!.add(use.patternId);
  }
  const done = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];
  const visit = (id: string): void => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const dependency of [...(graph.get(id) ?? [])].sort()) visit(dependency);
    visiting.delete(id);
    done.add(id);
    result.push(id);
  };
  for (const id of [...graph.keys()].sort()) visit(id);
  return result;
}

/** Validate instance attributes against the same native contract used by pattern authoring. */
export function validateSyncedPatternOverrideContent(
  tree: IntentTree,
  content: Record<string, Record<string, unknown>>,
): string[] {
  const contract = validatePatternOverrideContract(asAuthoringTemplate(tree.blocks), []);
  const errors = [...contract.errors];
  const allowed = new Map<string, Set<string>>();
  for (const binding of contract.bindings as PatternOverrideBinding[]) {
    const attrs = allowed.get(binding.name) ?? new Set<string>();
    attrs.add(binding.attribute);
    allowed.set(binding.name, attrs);
  }
  for (const [name, values] of Object.entries(content)) {
    const attrs = allowed.get(name);
    if (!attrs) errors.push(`metadata.name ${JSON.stringify(name)} is not declared as an editable pattern field.`);
    else for (const attribute of Object.keys(values)) if (!attrs.has(attribute)) errors.push(`${name}.${attribute} is not a supported declared override attribute.`);
  }
  return errors;
}

function asAuthoringTemplate(nodes: IntentNode[]): AuthoringTemplate {
  return nodes.map((node) => [node.block, { ...(node.attrs ?? {}) }, node.children ? asAuthoringTemplate(node.children) : []]);
}

function nodeAtPath(tree: IntentTree, path: number[]): IntentNode | undefined {
  let node: IntentNode | undefined = tree.blocks[path[0] ?? -1];
  for (const index of path.slice(1)) node = node?.children?.[index];
  return node;
}
