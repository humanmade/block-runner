import { compileThemeDocuments, compileSitePageDocuments, compileSiteSyncedPatterns } from './compile.js';
import { readSiteSnapshot, type SiteWpCliOptions, type SiteReadTransport } from './wpcli.js';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { hashBytes, readStableRegularFile } from '../publication.js';
import { prepareSiteSource, siteSourceIdentityMatches } from './input.js';
import { hashCanonicalJson } from '../proof/receipt.js';
import type { PreparedSiteSource, CompiledSitePage, SiteInputDiagnostic, ThemeArtifact, SiteAttachmentBinding } from './types.js';
import type { SiteEntity, SitePlan, SitePlanOperation, SiteSnapshot } from './plan-types.js';
import { attachmentVersionKey } from './media.js';
import type { CompiledSyncedPattern } from './patterns.js';

export function managedStateHash(state: Record<string, unknown>): string { return hashCanonicalJson(state); }
export function entityFingerprint(entity: SiteEntity): string { return hashCanonicalJson(entity); }

/** Pure reconciliation. It never adopts a numeric entity by title, route, or filename. */
export function reconcileSitePlan(source: PreparedSiteSource, theme: ThemeArtifact, pages: CompiledSitePage[], snapshot: SiteSnapshot, bindings: Record<string, SiteAttachmentBinding> = {}, previewDiagnostics: import('../types.js').ReportItem[] = [], compiledPatterns: CompiledSyncedPattern[] = [], patternBindings: Record<string, number> = {}): SitePlan {
  const conflicts: SiteInputDiagnostic[] = [];
  // Reports contain optional fields set to undefined; retain their JSON representation in plans.
  const diagnostics = JSON.parse(JSON.stringify([...theme.diagnostics, ...pages.flatMap(page=>page.diagnostics), ...previewDiagnostics])) as import('../types.js').ReportItem[];
  const operations: SitePlanOperation[] = [];
  const issue = (path: string, code: string, message: string): void => { conflicts.push({ path, code, message }); };
  const intent = source.sourceIntent;
  if (!/^7\.1(?:\.|$)/.test(snapshot.runtime.wordpress)) issue('/target/runtime', 'runtime-mismatch', 'WordPress 7.1 is required');
  if (snapshot.theme.slug !== intent.theme.slug) issue('/target/theme', 'theme-mismatch', 'activate the explicitly deployed intended theme before planning');
  if (hashCanonicalJson([...snapshot.theme.inventory].sort((a,b)=>a.path.localeCompare(b.path))) !== hashCanonicalJson([...theme.inventory].sort((a,b)=>a.path.localeCompare(b.path)))) issue('/target/theme/inventory', 'theme-bytes-mismatch', 'installed theme files differ from the independently compiled theme artifact');
  const capabilities = ['edit_pages', 'edit_others_pages', 'manage_options', 'edit_theme_options'];
  const patternDefinitions = Object.keys(intent.syncedPatterns?.definitions ?? {});
  if (patternDefinitions.length > 0) {
    capabilities.push('edit_posts', 'edit_others_posts');
    for (const id of patternDefinitions) {
      const existing = snapshot.entities.find((entity) => entity.kind === 'pattern' && entity.ownership.some((owner) =>
        owner.siteId === intent.siteId && owner.kind === 'pattern' && owner.entityId === id));
      if (existing?.state.status === 'publish') capabilities.push('edit_published_posts');
      else capabilities.push('publish_posts', 'publish_blocks');
    }
  }
  if (intent.pages.some(page => page.status === 'publish')) capabilities.push('publish_pages');
  if (source.assets.some(asset => asset.role === 'attachment')) capabilities.push('upload_files');
  if (!Number.isInteger(snapshot.principal.userId) || snapshot.principal.userId < 1) issue('/target/principal', 'unauthenticated-principal', 'select an authenticated WordPress principal with --wp-user or WP-CLI configuration');
  for (const capability of new Set(capabilities)) if (snapshot.principal.capabilities[capability] !== true) issue('/target/principal', 'missing-capability', `selected principal requires ${capability}`);
  if (snapshot.siteRecord?.operation && snapshot.siteRecord.operation.status !== 'completed') issue('/target/operations', 'outstanding-operation', 'reconcile the outstanding started or unknown operation before producing a fresh plan');

  if (snapshot.siteRecord && (snapshot.siteRecord.version !== 1 || snapshot.siteRecord.siteId !== intent.siteId)) issue('/target/siteRecord', 'invalid-site-record', 'site operation record identity is inconsistent');
  for (const override of snapshot.overrides) if (override.theme.includes(snapshot.theme.slug)) issue(`/target/overrides/${override.id}`, 'theme-shadow', 'database template or part shadows the installed theme; resolve it explicitly');
  const trees = [
    ...Object.entries(intent.templates).map(([id, value]) => ({ id: `template:${id}`, body: value.body })),
    ...Object.entries(intent.parts).map(([id, value]) => ({ id: `part:${id}`, body: value.body })),
    ...Object.entries(intent.patterns).map(([id, value]) => ({ id: `pattern:${id}`, body: value.body })),
    ...Object.entries(intent.syncedPatterns?.definitions ?? {}).map(([id, value]) => ({ id: `synced-pattern:${id}`, body: value.body })),
    ...intent.pages.map((page) => ({ id: `page:${page.id}`, body: page.body })),
  ];
  const visit = (nodes: import('../types.js').IntentNode[], documentId: string, parent: number[] = []): void => {
    for (const [index, node] of nodes.entries()) {
      const at = [...parent, index];
      if (node.block === 'core/navigation' && node.attrs?.ref !== undefined) issue('/source/references', 'unsupported-navigation-reference', 'external native navigation references require explicit supported dependency handling');
      if (node.block === 'core/block' && !intent.syncedPatterns?.uses.some(use => use.documentId === documentId && use.nodePath.join('.') === at.join('.'))) issue('/source/references', 'unsupported-synced-pattern-reference', 'external synced-pattern references require explicit supported dependency handling');
      if (node.children) visit(node.children, documentId, at);
    }
  };
  for (const tree of trees) visit(tree.body.blocks, tree.id);
  if (snapshot.routing.unsupportedReason || !snapshot.routing.permalinkStructure || !snapshot.routing.rewriteRulesHash) issue('/target/routing', 'unsupported-routing', snapshot.routing.unsupportedReason ?? 'cached pretty-permalink routing is required');
  const owned = new Map<string, SiteEntity>();
  const ids = new Set<number>();
  for (const entity of snapshot.entities) {
    if (!Number.isInteger(entity.id) || entity.id < 1 || ids.has(entity.id)) issue('/target/entities', 'invalid-entity-id', 'snapshot contains missing or duplicate numeric entity IDs');
    ids.add(entity.id);
    if (entity.ownership.length > 1) issue(`/target/entities/${entity.id}`, 'duplicate-ownership-metadata', 'multiple ownership metadata rows are ambiguous');
    const ownership = entity.ownership[0];
    if (!ownership || ownership.siteId !== intent.siteId) continue;
    const baselineMatches = ownership.lastAppliedHash === managedStateHash(entity.state);
    if (ownership.version !== 1 || ownership.kind !== entity.kind || !ownership.entityId || !ownership.lastAppliedHash
      || (entity.kind !== 'attachment' && ownership.assetSha256 !== undefined)
      || (ownership.assetSha256 !== undefined && !/^[a-f0-9]{64}$/.test(ownership.assetSha256))) issue(`/target/entities/${entity.id}`, 'invalid-ownership', 'ownership metadata is incomplete or inconsistent');
    else if (!baselineMatches) issue(`/target/entities/${entity.id}`, 'managed-state-changed', 'current managed fields differ from the complete last-applied baseline');
    if (entity.kind === 'attachment') {
      if (entity.postStatus !== 'inherit') issue(`/target/entities/${entity.id}`, 'unavailable-owned-attachment', 'only inherited attachments are available for exact owned media reuse');
      const sha256 = ownership.assetSha256 ?? (baselineMatches && typeof entity.state.sha256 === 'string' ? entity.state.sha256 : undefined);
      if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256) || (ownership.assetSha256 !== undefined && entity.state.sha256 !== sha256)) {
        issue(`/target/entities/${entity.id}`, 'invalid-attachment-version', 'owned attachment has no verified original-byte version');
        continue;
      }
      const key = attachmentVersionKey(ownership.entityId, sha256);
      if (owned.has(key)) issue(`/target/entities/${entity.id}`, 'duplicate-ownership', `duplicate owned attachment version ${key}`);
      else owned.set(key, entity);
    } else {
      const key = `${ownership.kind}:${ownership.entityId}`;
      if (owned.has(key)) issue(`/target/entities/${entity.id}`, 'duplicate-ownership', `duplicate logical ownership key ${key}`);
      else owned.set(key, entity);
    }
  }

  for (const [key, id] of Object.entries(snapshot.siteRecord?.entities ?? {})) {
    const legacyMatch = /^attachment:([^@]+)$/.exec(key);
    const entity = owned.get(key) ?? (legacyMatch ? snapshot.entities.find(item => item.kind === 'attachment' && item.id === id
      && item.ownership.some(meta => meta.siteId === intent.siteId && meta.entityId === legacyMatch[1] && meta.assetSha256 === undefined
        && meta.lastAppliedHash === managedStateHash(item.state))) : undefined);
    if (!entity || entity.id !== id) issue(`/target/entities/${id}`, 'missing-owned-id', `previously owned entity ${key} is missing or its metadata changed`);
  }
  const desiredKeys = new Set<string>();
  // Attachments precede pages; new bindings remain logical pending references.
  for (const asset of source.assets.filter(asset => asset.role === 'attachment').sort((a,b) => a.id.localeCompare(b.id))) {
    const key = attachmentVersionKey(asset.id, asset.sha256); desiredKeys.add(key);
    const existing = owned.get(key);
    const external = !existing && bindings[asset.id];
    const boundEntity = external ? snapshot.entities.find(entity=>entity.id===external.id && entity.kind==='attachment') : undefined;
    if (external && (!boundEntity || boundEntity.state.sha256 !== asset.sha256 || boundEntity.attachment?.url !== external.url
      || !boundEntity.ownership.some(meta=>meta.siteId===intent.siteId && meta.entityId===asset.id
        && (meta.assetSha256 ?? (meta.lastAppliedHash === managedStateHash(boundEntity.state) ? boundEntity.state.sha256 : undefined)) === asset.sha256))) {
      issue(`/assets/${asset.id}`, 'binding-target-mismatch', 'attachment binding does not match exact owned destination identity and bytes');
    }
    const desired = { sha256: asset.sha256, assetSha256: asset.sha256 };
    operations.push(existing
      ? { action: 'retain', kind: 'attachment', entityId: asset.id, id: existing.id, desired, beforeFingerprint: entityFingerprint(existing) }
      : external ? { action: 'retain', kind: 'attachment', entityId: asset.id, id: external.id, desired, externalBinding: true, ...(boundEntity ? { beforeFingerprint: entityFingerprint(boundEntity) } : {}) }
      : { action: 'create', kind: 'attachment', entityId: asset.id, desired });
  }
  for (const pattern of compiledPatterns) {
    const key = `pattern:${pattern.id}`; desiredKeys.add(key);
    const existing = owned.get(key);
    const ready = pattern.ok && pattern.content !== undefined && pattern.pendingUses.length === 0 && pattern.pendingBindings.length === 0;
    const desired: Record<string, unknown> = { title: pattern.title, ...(ready ? { content: pattern.content } : {}), status: 'publish' };
    const same = existing && ready && hashCanonicalJson(existing.state) === hashCanonicalJson(desired);
    operations.push({ action: existing ? (same ? 'retain' : 'update') : 'create', kind: 'pattern', entityId: pattern.id,
      ...(existing ? { id: existing.id, beforeFingerprint: entityFingerprint(existing) } : {}), desired,
      ...(!ready ? { requiresFinalization: true, body: pattern.body, ...(pattern.pendingUses.length ? { pendingPatternUses: pattern.pendingUses } : {}), ...(pattern.pendingBindings.length ? { pendingBindings: pattern.pendingBindings } : {}) } : {}),
    });
    for (const diagnostic of pattern.diagnostics) {
      const serialized = JSON.stringify(diagnostic);
      if (!diagnostics.some((item) => JSON.stringify(item) === serialized)) diagnostics.push(diagnostic);
      if (diagnostic.status === 'invalid') issue(`/syncedPatterns/definitions/${pattern.id}`, diagnostic.code ?? 'synced-pattern-invalid', diagnostic.reason);
    }
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
    if (page.route !== '/') {
      const resolved = snapshot.routing.routes.find(route=>route.route===page.route);
      if (!resolved || resolved.kind==='unsupported') issue(`/pages/${page.id}/route`, 'unsupported-route', resolved?.reason ?? 'route has no native resolution snapshot');
      else if (resolved.kind==='reserved' || (resolved.kind==='singular' && resolved.postId!==existing?.id)) issue(`/pages/${page.id}/route`, 'route-conflict', 'route resolves to a reserved endpoint or an existing unowned post/entity');
    }
    const occupied = snapshot.entities.find(entity => entity.kind === 'page' && normalizeRoute(entity.route) === normalizeRoute(page.route) && entity.id !== existing?.id);
    if (occupied) issue(`/pages/${page.id}/route`, 'route-conflict', `route is occupied by page ID ${occupied.id}; no adoption is permitted`);
    const pendingBindings = intent.assetUses.filter(use => {
      if (use.documentId !== key || bindings[use.assetId]) return false;
      const asset = source.assets.find(candidate=>candidate.id===use.assetId && candidate.role==='attachment');
      return Boolean(asset && !owned.has(attachmentVersionKey(asset.id, asset.sha256)));
    });
    const output = compiled.get(page.id);
    const pendingPatternUses = intent.syncedPatterns?.uses.filter(use => use.documentId === key && !patternBindings[use.patternId]) ?? [];
    if (!output && pendingBindings.length === 0 && pendingPatternUses.length === 0) issue(`/pages/${page.id}/body`, 'uncompiled-page', 'page has no finalized content and no declared pending bindings');
    const pendingParent = page.parentId && !pageIds.has(page.parentId);
    const desired: Record<string, unknown> = {
      title: page.title, slug: page.route === '/' ? page.id : page.route.split('/').at(-1)!,
      parentId: page.parentId ? (pageIds.get(page.parentId) ?? { pendingPageId: page.parentId }) : 0,
      template: page.template, status: page.status ?? 'draft',
      ...(output && pendingBindings.length === 0 && pendingPatternUses.length === 0 ? { content: output.content } : {}),
    };
    const needsFinalization = pendingBindings.length > 0 || pendingPatternUses.length > 0 || Boolean(pendingParent);
    const same = existing && !needsFinalization && hashCanonicalJson(existing.state) === hashCanonicalJson(desired);
    operations.push({ action: existing ? (same ? 'retain' : 'update') : 'create', kind: 'page', entityId: page.id,
      ...(existing ? { id: existing.id, beforeFingerprint: entityFingerprint(existing) } : {}), desired,
      ...(needsFinalization ? { requiresFinalization: true } : {}),
      ...(pendingBindings.length ? { pendingBindings, body: page.body } : {}),
      ...(pendingPatternUses.length ? { pendingPatternUses, body: page.body } : {}),
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
    assets: source.assets.map(({id,path,sha256})=>({id,path,sha256})), snapshot, snapshotFingerprint: hashCanonicalJson(snapshot), operations, conflicts, diagnostics, executable: conflicts.length === 0 };
  return { ...body, confirmationHash: hashCanonicalJson(body) };
}
function normalizeRoute(route: string | null): string { return (route ?? '').replace(/\/$/, '').toLowerCase(); }

export interface SitePlanInput {
  source: PreparedSiteSource;
  retainedBindings: Record<string, SiteAttachmentBinding>;
  retainedThemeAssetBaseUrl?: string;
  sourceIntentState?: 'unreconciled';
  artifactIdentity?: string;
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
    artifactIdentity?: string; sourceIntentState?: string;
    sourceAssets: Array<{id:string;path:string;sha256:string;size:number;kind:string;role:string}>;
    bundleFiles: Array<{path:string;sha256:string;size:number}>;
    targetBindings: Record<string,SiteAttachmentBinding>; themeAssetBaseUrl?: string;
  };
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.bundleFiles) || !Array.isArray(manifest.sourceAssets) || !manifest.targetBindings
    || (manifest.sourceIntentState !== undefined && manifest.sourceIntentState !== 'unreconciled')) throw new Error('invalid retained site manifest');
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
  if (source.sourceIntent.siteId !== manifest.siteId || !siteSourceIdentityMatches(source.sourceIntent, manifest.sourceIdentity)) throw new Error('retained source identity differs from bundle manifest');
  // Keep persisted identity exact: accepting old insertion-order hashes must not rewrite confirmations.
  source.sourceIdentity = manifest.sourceIdentity;
  const assets = source.assets.map(asset=>({id:asset.id,path:asset.path,kind:asset.kind,role:asset.role,sha256:asset.sha256,size:asset.bytes.byteLength}));
  if (hashCanonicalJson(assets) !== hashCanonicalJson(manifest.sourceAssets)) throw new Error('retained source asset inventory differs from bundle manifest');
  if (source.assets.some(asset=>!paths.has(`source/assets/${asset.path}`))) throw new Error('retained manifest omits declared source asset bytes');
  if (!(await read('site.manifest.json')).equals(manifestBytes)) throw new Error('retained manifest changed while reading bundle');
  return { source, retainedBindings: manifest.targetBindings, ...(manifest.themeAssetBaseUrl !== undefined ? {retainedThemeAssetBaseUrl:manifest.themeAssetBaseUrl} : {}),
    ...(manifest.sourceIntentState === 'unreconciled' ? { sourceIntentState: 'unreconciled' as const } : {}),
    ...(typeof manifest.artifactIdentity === 'string' ? { artifactIdentity: manifest.artifactIdentity } : {}) };
}

async function assertSafePath(file: string): Promise<void> {
  const root = path.parse(file).root;
  let current = root;
  for (const component of file.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current,component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('site input path cannot contain symlinks');
  }
}

/** Retained numeric bindings are accepted only after observing their exact destination bytes. */
export function observedAttachmentBindings(input: SitePlanInput, snapshot: SiteSnapshot): Record<string, SiteAttachmentBinding> {
  if (input.retainedThemeAssetBaseUrl !== undefined && input.retainedThemeAssetBaseUrl !== snapshot.theme.assetBaseUrl) throw new Error('retained theme asset base URL belongs to a different target');
  const result: Record<string, SiteAttachmentBinding> = {};
  for (const asset of input.source.assets.filter(item=>item.role === 'attachment')) {
    const retained = input.retainedBindings[asset.id];
    const ownedVersions = snapshot.entities.filter(entity=>entity.kind === 'attachment' && entity.ownership.some(meta=>meta.siteId===input.source.sourceIntent.siteId && meta.entityId===asset.id));
    const candidates = ownedVersions.filter(entity=>entity.ownership.some(meta=>meta.siteId===input.source.sourceIntent.siteId && meta.entityId===asset.id
      && (meta.assetSha256 ?? (meta.lastAppliedHash === managedStateHash(entity.state) ? entity.state.sha256 : undefined)) === asset.sha256));
    if (candidates.length > 1) throw new Error(`duplicate owned attachment version for ${asset.id}`);
    const observed = retained ? snapshot.entities.find(entity=>entity.kind==='attachment' && entity.id===retained.id) : candidates[0];
    if (!observed) { if (retained) throw new Error(`retained attachment binding ${asset.id} is absent on the observed target`); continue; }
    const exactOwner = observed.ownership.some(meta=>meta.siteId===input.source.sourceIntent.siteId && meta.entityId===asset.id
      && (meta.assetSha256 ?? (meta.lastAppliedHash === managedStateHash(observed.state) ? observed.state.sha256 : undefined)) === asset.sha256);
    if (observed.postStatus !== 'inherit' || !exactOwner || observed.state.sha256 !== asset.sha256 || typeof observed.attachment?.url !== 'string' || (retained && observed.attachment?.url !== retained.url)) throw new Error(`attachment binding ${asset.id} is unavailable or differs from exact owned destination bytes or URL`);
    const url = new URL(observed.attachment!.url!);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('attachment URL contains unsupported identity or secret fields');
    result[asset.id] = { id: observed.id, url: observed.attachment!.url!, ...(observed.attachment!.linkUrl ? { attachmentPageUrl: observed.attachment!.linkUrl } : {}),
      ...(observed.attachment!.width && observed.attachment!.height ? { observedSize: { width: observed.attachment!.width, height: observed.attachment!.height } } : {}),
      ...(observed.attachment!.sizes ? { imageSizes: observed.attachment!.sizes } : {}) };
  }
  for (const id of Object.keys(input.retainedBindings)) if (!input.source.assets.some(asset=>asset.id===id && asset.role==='attachment')) throw new Error(`retained binding ${id} has no declared attachment asset`);
  return result;
}

export interface SitePlanOptions extends SiteWpCliOptions { assetRoot?: string; strict?: boolean }

/** Source-first orchestration reads WordPress once and never publishes or mutates it. */
export async function planSite(inputPath: string, options: SitePlanOptions, transport?: SiteReadTransport): Promise<SitePlan> {
  const input = await readSitePlanInput(inputPath, options.assetRoot);
  const observed = await readSiteSnapshot(options, input.source.sourceIntent.siteId, transport, input.source.sourceIntent.pages.map(page=>page.route));
  return planPreparedSite(input, observed, options);
}

/** Reconstruct semantics from already verified source and an explicit snapshot, without filesystem or WordPress reads. */
export async function planPreparedSite(input: SitePlanInput, observed: SiteSnapshot, options: Pick<SitePlanOptions, 'strict'> = {}): Promise<SitePlan> {
  if (input.sourceIntentState === 'unreconciled') {
    const body = {
      version: 1 as const,
      siteId: input.source.sourceIntent.siteId,
      sourceIdentity: input.source.sourceIdentity,
      artifactIdentity: input.artifactIdentity ?? '',
      assets: input.source.assets.map(asset => ({ id: asset.id, path: asset.path, sha256: asset.sha256 })),
      snapshot: observed,
      snapshotFingerprint: hashCanonicalJson(observed),
      operations: [],
      conflicts: [{ path: '/source', code: 'source-intent-out-of-date', message: 'This generated bundle contains adopted theme markup while its original SiteIntent remains unchanged; reconcile the source intent before planning destination writes.' }],
      diagnostics: [],
      executable: false,
    };
    return { ...body, confirmationHash: hashCanonicalJson(body) };
  }
  const bindings = observedAttachmentBindings(input, observed);
  const patternBindings = observedPatternBindings(input.source.sourceIntent.siteId, observed);
  const compileOptions = { attachmentBindings: bindings, patternBindings, themeAssetBaseUrl: observed.theme.assetBaseUrl, strict: options.strict };
  const theme = await compileThemeDocuments(input.source, compileOptions);
  if (!theme.ok) throw new Error(theme.diagnostics.map(item=>`${item.source?.path ?? 'source'}: ${item.code ?? item.status}: ${item.reason}`).join('\n'));
  // Check every explicit media ID against this exact destination before invoking the native gate.
  const intent = input.source.sourceIntent;
  const trees = [
    ...Object.entries(intent.templates).map(([id,value])=>({id:`template:${id}`,body:value.body})),
    ...Object.entries(intent.parts).map(([id,value])=>({id:`part:${id}`,body:value.body})),
    ...Object.entries(intent.patterns).map(([id,value])=>({id:`pattern:${id}`,body:value.body})),
    ...Object.entries(intent.syncedPatterns?.definitions ?? {}).map(([id,value])=>({id:`synced-pattern:${id}`,body:value.body})),
    ...intent.pages.map(page=>({id:`page:${page.id}`,body:page.body})),
  ];
  const check = (nodes: import('../types.js').IntentNode[], documentId: string, parent: number[]): void => {
    nodes.forEach((node,index)=>{
      const at = [...parent,index];
      if ((node.block==='core/image' || node.block==='core/cover') && typeof node.attrs?.id === 'number') {
        const declared = intent.assetUses.some(use=>use.documentId===documentId && use.nodePath.join('.')===at.join('.') && intent.assets.some(asset=>asset.id===use.assetId && asset.role==='attachment'));
        const entity = observed.entities.find(item=>item.kind==='attachment' && item.id===node.attrs!.id);
        const url = node.url ?? node.attrs.url;
        // Zero on an explicit asset-use field is caller source, never a destination binding.
        if (!(node.attrs.id === 0 && declared) && (!entity || (typeof url === 'string' && url !== entity.attachment?.url))) throw new Error('inline media ID or URL does not match the observed destination');
      }
      if (node.block==='core/block' && !intent.syncedPatterns?.uses.some(use=>use.documentId===documentId && use.nodePath.join('.')===at.join('.'))) throw new Error('undeclared core/block reference is not a supported synced pattern use');
      if (node.children) check(node.children,documentId,at);
    });
  };
  for (const document of trees) check(document.body.blocks,document.id,[]);
  const compiledPatterns = await compileSiteSyncedPatterns(input.source, compileOptions);
  const inspected = await compileSitePageDocuments(input.source, compileOptions);
  if (!inspected.ok) throw new Error(inspected.diagnostics.filter(item=>item.status==='invalid').map(item=>`${item.source?.path ?? 'source'}: ${item.code ?? item.status}: ${item.reason}`).join('\n'));
  return reconcileSitePlan(input.source, theme.artifact, inspected.pages, observed, bindings, inspected.diagnostics, compiledPatterns, patternBindings);
}

function observedPatternBindings(siteId: string, snapshot: SiteSnapshot): Record<string, number> {
  const grouped = new Map<string, SiteEntity[]>();
  for (const entity of snapshot.entities) {
    if (entity.kind !== 'pattern') continue;
    const owner = entity.ownership.find(meta => meta.siteId === siteId && meta.kind === 'pattern');
    if (!owner || owner.lastAppliedHash !== managedStateHash(entity.state)) continue;
    const list = grouped.get(owner.entityId) ?? [];
    list.push(entity);
    grouped.set(owner.entityId, list);
  }
  return Object.fromEntries([...grouped].filter(([, entities]) => entities.length === 1).map(([id, entities]) => [id, entities[0]!.id]));
}
