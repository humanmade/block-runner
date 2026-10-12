import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { hashBytes, readStableRegularFile } from '../publication.js';
import { prepareSiteSource } from './input.js';
import { hashCanonicalJson } from '../proof/receipt.js';
import type { PreparedSiteSource, CompiledSitePage, SiteInputDiagnostic, ThemeArtifact, SiteAttachmentBinding } from './types.js';
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

  for (const [key, id] of Object.entries(snapshot.siteRecord?.entities ?? {})) {
    const entity = owned.get(key);
    if (!entity || entity.id !== id) issue(`/target/entities/${id}`, 'missing-owned-id', `previously owned entity ${key} is missing or its metadata changed`);
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
    const parentRoute = page.parentId ? intent.pages.find(candidate => candidate.id === page.parentId)?.route : '/';
    const routePrefix = page.route === '/' ? '/' : (page.route.slice(0, page.route.lastIndexOf('/')) || '/');
    if (routePrefix !== parentRoute) issue(`/pages/${page.id}/route`, 'route-parent-mismatch', 'route prefix must match the explicitly declared parent route; inferred parents are unsupported');
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
      ...(output && pendingBindings.length === 0 ? { content: output.content } : {}),
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

export interface SitePlanInput {
  source: PreparedSiteSource;
  retainedBindings: Record<string, SiteAttachmentBinding>;
  retainedThemeAssetBaseUrl?: string;
}

/** Read either an explicit source file or the retained source of a stable compiled bundle. */
export async function readSitePlanInput(inputPath: string, assetRoot?: string): Promise<SitePlanInput> {
  const input = path.resolve(inputPath);
  await assertSafePath(input);
  const info = await lstat(input);
  if (info.isFile()) {
    if (!assetRoot) throw new Error('raw site intent planning requires an explicit asset root');
    const file = await readStableRegularFile(input, 'site intent changed while reading');
    const prepared = await prepareSiteSource(JSON.parse(file.content.toString('utf8')), assetRoot);
    if (!prepared.ok) throw new Error(prepared.diagnostics.map(item => `${item.path}: ${item.message}`).join('\n'));
    return { source: prepared.source, retainedBindings: {} };
  }
  if (!info.isDirectory()) throw new Error('site plan input must be a regular source file or bundle directory');
  const read = async (relative: string): Promise<Buffer> => {
    if (!relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(component => !component || component === '.' || component === '..') || path.isAbsolute(relative)) throw new Error('unsafe retained bundle path');
    const file = path.join(input, ...relative.split('/')); await assertSafePath(file);
    return (await readStableRegularFile(file, 'retained bundle file changed while reading')).content;
  };
  const manifestBytes = await read('site.manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    formatVersion: number; siteId: string; sourceIdentity: string;
    sourceAssets: Array<{id:string;path:string;sha256:string;size:number;kind:string;role:string}>;
    bundleFiles: Array<{path:string;sha256:string;size:number}>;
    targetBindings: Record<string,SiteAttachmentBinding>; themeAssetBaseUrl?: string;
  };
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.bundleFiles) || !Array.isArray(manifest.sourceAssets) || !manifest.targetBindings) throw new Error('invalid retained site manifest');
  const paths = new Set<string>();
  for (const entry of manifest.bundleFiles) {
    if (paths.has(entry.path)) throw new Error('duplicate retained bundle path'); paths.add(entry.path);
    const bytes = await read(entry.path);
    if (bytes.byteLength !== entry.size || hashBytes(bytes) !== entry.sha256) throw new Error(`retained bundle bytes differ for ${entry.path}`);
  }
  if (!paths.has('site.intent.json')) throw new Error('retained manifest omits site intent');
  const retainedIntent = JSON.parse((await read('site.intent.json')).toString('utf8'));
  // Empty declarations require no asset reads; writers need not emit an empty directory.
  const retainedAssetRoot = Array.isArray(retainedIntent.assets) && retainedIntent.assets.length === 0 ? input : path.join(input,'source/assets');
  const prepared = await prepareSiteSource(retainedIntent, retainedAssetRoot);
  if (!prepared.ok) throw new Error(prepared.diagnostics.map(item=>`${item.path}: ${item.message}`).join('\n'));
  const source = prepared.source;
  if (source.sourceIntent.siteId !== manifest.siteId || source.sourceIdentity !== manifest.sourceIdentity) throw new Error('retained source identity differs from bundle manifest');
  const assets = source.assets.map(asset=>({id:asset.id,path:asset.path,kind:asset.kind,role:asset.role,sha256:asset.sha256,size:asset.bytes.byteLength}));
  if (hashCanonicalJson(assets) !== hashCanonicalJson(manifest.sourceAssets)) throw new Error('retained source asset inventory differs from bundle manifest');
  if (source.assets.some(asset=>!paths.has(`source/assets/${asset.path}`))) throw new Error('retained manifest omits declared source asset bytes');
  if (!(await read('site.manifest.json')).equals(manifestBytes)) throw new Error('retained manifest changed while reading bundle');
  return { source, retainedBindings: manifest.targetBindings, ...(manifest.themeAssetBaseUrl !== undefined ? {retainedThemeAssetBaseUrl:manifest.themeAssetBaseUrl} : {}) };
}

async function assertSafePath(file: string): Promise<void> {
  const root = path.parse(file).root;
  let current = root;
  for (const component of file.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('site input path cannot contain symlinks');
  }
}
