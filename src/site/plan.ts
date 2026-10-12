import { hashCanonicalJson } from '../proof/receipt.js';
import type { PreparedSiteSource, CompiledSitePage, SiteInputDiagnostic, ThemeArtifact } from './types.js';
import type { SiteEntity, SitePlan, SitePlanOperation, SiteSnapshot } from './plan-types.js';

export function managedStateHash(state: Record<string, unknown>): string { return hashCanonicalJson(state); }
export function entityFingerprint(entity: SiteEntity): string { return hashCanonicalJson(entity); }

/** Pure reconciliation. It never adopts a numeric entity by title, route, or filename. */
export function reconcileSitePlan(source: PreparedSiteSource, theme: ThemeArtifact, pages: CompiledSitePage[], snapshot: SiteSnapshot): SitePlan {
  const conflicts: SiteInputDiagnostic[] = [];
  const operations: SitePlanOperation[] = [];
  const issue = (path: string, code: string, message: string): void => { conflicts.push({ path, code, message }); };
  const intent = source.sourceIntent;
  if (!/^7\.1(?:\.|$)/.test(snapshot.runtime.wordpress)) issue('/target/runtime', 'runtime-mismatch', 'WordPress 7.1 is required');
  if (snapshot.theme.slug !== intent.theme.slug) issue('/target/theme', 'theme-mismatch', 'activate the explicitly deployed intended theme before planning');
  if (hashCanonicalJson(snapshot.theme.inventory) !== hashCanonicalJson(theme.inventory)) issue('/target/theme/inventory', 'theme-bytes-mismatch', 'installed theme files differ from the independently compiled theme artifact');
  const capabilities = ['edit_pages', 'edit_others_pages', 'manage_options', 'edit_theme_options'];
  if (intent.pages.some(page => page.status === 'publish')) capabilities.push('publish_pages');
  if (source.assets.some(asset => asset.role === 'attachment')) capabilities.push('upload_files');
  if (!Number.isInteger(snapshot.principal.userId) || snapshot.principal.userId < 1) issue('/target/principal', 'unauthenticated-principal', 'select an authenticated WordPress principal with --wp-user or WP-CLI configuration');
  for (const capability of capabilities) if (snapshot.principal.capabilities[capability] !== true) issue('/target/principal', 'missing-capability', `selected principal requires ${capability}`);
  if (snapshot.siteRecord?.operation && ['started','outcome_unknown'].includes(snapshot.siteRecord.operation.status)) issue('/target/operations', 'outstanding-operation', 'reconcile the outstanding started or unknown operation before producing a fresh plan');

  if (snapshot.siteRecord && (snapshot.siteRecord.version !== 1 || snapshot.siteRecord.siteId !== intent.siteId)) issue('/target/siteRecord', 'invalid-site-record', 'site operation record identity is inconsistent');
  for (const override of snapshot.overrides) if (override.theme.includes(snapshot.theme.slug)) issue(`/target/overrides/${override.id}`, 'theme-shadow', 'database template or part shadows the installed theme; resolve it explicitly');
  const trees = [...Object.values(intent.templates), ...Object.values(intent.parts), ...Object.values(intent.patterns), ...intent.pages];
  const visit = (nodes: import('../types.js').IntentNode[]): void => {
    for (const node of nodes) {
      if (node.block === 'core/navigation' && node.attrs?.ref !== undefined) issue('/source/references', 'unsupported-navigation-reference', 'external native navigation references require explicit supported dependency handling');
      if (node.block === 'core/block') issue('/source/references', 'unsupported-synced-pattern-reference', 'external synced-pattern references require explicit supported dependency handling');
      if (node.children) visit(node.children);
    }
  };
  for (const tree of trees) visit(tree.body.blocks);
  const owned = new Map<string, SiteEntity>();
  const ids = new Set<number>();
  for (const entity of snapshot.entities) {
    if (!Number.isInteger(entity.id) || entity.id < 1 || ids.has(entity.id)) issue('/target/entities', 'invalid-entity-id', 'snapshot contains missing or duplicate numeric entity IDs');
    ids.add(entity.id);
    if (entity.ownership.length > 1) issue(`/target/entities/${entity.id}`, 'duplicate-ownership-metadata', 'multiple ownership metadata rows are ambiguous');
    const ownership = entity.ownership[0];
    if (!ownership || ownership.siteId !== intent.siteId) continue;
    const key = `${ownership.kind}:${ownership.entityId}`;
    if (ownership.version !== 1 || ownership.kind !== entity.kind || !ownership.entityId || !ownership.lastAppliedHash) issue(`/target/entities/${entity.id}`, 'invalid-ownership', 'ownership metadata is incomplete or inconsistent');
    else if (ownership.lastAppliedHash !== managedStateHash(entity.state)) issue(`/target/entities/${entity.id}`, 'managed-state-changed', 'current managed fields differ from the complete last-applied baseline');
    if (owned.has(key)) issue(`/target/entities/${entity.id}`, 'duplicate-ownership', `duplicate logical ownership key ${key}`);
    else owned.set(key, entity);
  }

  const desiredKeys = new Set<string>();
  // Attachments precede pages; new bindings remain logical pending references.
  for (const asset of source.assets.filter(asset => asset.role === 'attachment').sort((a,b) => a.id.localeCompare(b.id))) {
    const key = `attachment:${asset.id}`; desiredKeys.add(key);
    const existing = owned.get(key);
    const desired = { sha256: asset.sha256 };
    if (existing && existing.state.sha256 !== asset.sha256) issue(`/assets/${asset.id}`, 'attachment-bytes-changed', 'attachment replacement is unsupported; declare a new logical attachment identity');
    operations.push(existing
      ? { action: 'retain', kind: 'attachment', entityId: asset.id, id: existing.id, beforeFingerprint: entityFingerprint(existing) }
      : { action: 'create', kind: 'attachment', entityId: asset.id, desired });
  }
  const pageIds = new Map([...owned.entries()].filter(([key]) => key.startsWith('page:')).map(([key,entity]) => [key.slice(5), entity.id]));
  const compiled = new Map(pages.map(page => [page.id,page]));
  const orderedPages = [...intent.pages].sort((a,b) => depth(a.id) - depth(b.id) || a.id.localeCompare(b.id));
  function depth(id: string): number { const page = intent.pages.find(item=>item.id===id); return page?.parentId ? 1 + depth(page.parentId) : 0; }
  for (const page of orderedPages) {
    const key = `page:${page.id}`; desiredKeys.add(key);
    const existing = owned.get(key);
    const occupied = snapshot.entities.find(entity => entity.kind === 'page' && normalizeRoute(entity.route) === normalizeRoute(page.route) && entity.id !== existing?.id);
    if (occupied) issue(`/pages/${page.id}/route`, 'route-conflict', `route is occupied by page ID ${occupied.id}; no adoption is permitted`);
    const pendingBindings = intent.assetUses.filter(use => use.documentId === key && !owned.has(`attachment:${use.assetId}`) && source.assets.some(asset=>asset.id===use.assetId && asset.role==='attachment'));
    const output = compiled.get(page.id);
    if (!output && pendingBindings.length === 0) issue(`/pages/${page.id}/body`, 'uncompiled-page', 'page has no finalized content and no declared pending bindings');
    const pendingParent = page.parentId && !pageIds.has(page.parentId);
    const desired: Record<string, unknown> = {
      title: page.title, slug: page.route === '/' ? page.id : page.route.split('/').at(-1)!,
      parentId: page.parentId ? (pageIds.get(page.parentId) ?? { pendingPageId: page.parentId }) : 0,
      template: page.template, status: page.status ?? 'draft',
      ...(output ? { content: output.content } : {}),
    };
    const needsFinalization = pendingBindings.length > 0 || Boolean(pendingParent);
    const same = existing && !needsFinalization && hashCanonicalJson(existing.state) === hashCanonicalJson(desired);
    operations.push({ action: existing ? (same ? 'retain' : 'update') : 'create', kind: 'page', entityId: page.id,
      ...(existing ? { id: existing.id, beforeFingerprint: entityFingerprint(existing) } : {}), desired,
      ...(needsFinalization ? { requiresFinalization: true } : {}),
      ...(pendingBindings.length ? { pendingBindings, body: page.body } : {}),
    });
  }
  for (const [key, entity] of [...owned.entries()].sort(([a],[b])=>a.localeCompare(b))) {
    if (!desiredKeys.has(key)) operations.push({ action: 'retain', kind: entity.kind, entityId: entity.ownership[0]!.entityId, id: entity.id, beforeFingerprint: entityFingerprint(entity), desired: { orphaned: true } });
  }
  const homeId = pageIds.get(intent.homePageId) ?? { pendingPageId: intent.homePageId };
  for (const [name,value] of Object.entries({ show_on_front: 'page', page_on_front: homeId })) {
    const baseline = snapshot.siteRecord?.options[name];
    if (baseline && hashCanonicalJson(baseline.lastAppliedValue) !== hashCanonicalJson(snapshot.options[name])) issue(`/target/options/${name}`, 'managed-option-changed', 'managed option changed since last apply');
    if (hashCanonicalJson(snapshot.options[name]) !== hashCanonicalJson(value)) operations.push({ action: 'set-option', kind: 'option', entityId: name, beforeFingerprint: hashCanonicalJson(snapshot.options[name]), desired: { value, previousValue: snapshot.options[name] } });
  }
  const body = { version: 1 as const, siteId: intent.siteId, sourceIdentity: source.sourceIdentity, artifactIdentity: theme.artifactIdentity,
    assets: source.assets.map(({id,path,sha256})=>({id,path,sha256})), snapshot, snapshotFingerprint: hashCanonicalJson(snapshot), operations, conflicts, executable: conflicts.length === 0 };
  return { ...body, confirmationHash: hashCanonicalJson(body) };
}
function normalizeRoute(route: string | null): string { return (route ?? '').replace(/\/$/, '').toLowerCase(); }
