import path from 'node:path';
import { compareThemeMarkup } from '../proof/theme.js';
import { hashCanonicalJson } from '../proof/receipt.js';
import { hashBytes, readStableRegularFile } from '../publication.js';
import type { SiteEntity, SiteSnapshot } from './plan-types.js';
import { managedStateHash, readSitePlanInput } from './plan.js';
import { verifiedOwnedAttachment } from './media.js';
import { readSiteSnapshot, readSiteTemplateSnapshot, type SiteReadTransport, type SiteTemplateSnapshot, type SiteWpCliOptions } from './wpcli.js';

export type SiteDriftFindingStatus = 'clean' | 'equivalent-override' | 'changed' | 'missing' | 'orphaned' | 'conflict' | 'dependency' | 'blocked';
export interface SiteDriftFinding {
  kind: 'template' | 'part' | 'page' | 'pattern' | 'attachment' | 'option' | 'dependency' | 'inspection';
  status: SiteDriftFindingStatus;
  entityId?: string;
  sourcePath?: string;
  wpId?: number;
  code: string;
  message: string;
  sourceSha256?: string;
  observedSha256?: string;
  firstDifferenceByte?: number;
}
export interface SiteDriftReport {
  version: 1;
  status: 'clean' | 'actionable' | 'blocked';
  target: { homeUrl: string; siteUrl: string; blogId: number; theme: string } | null;
  bundle: { siteId: string; sourceIdentity: string; artifactIdentity: string };
  findings: SiteDriftFinding[];
}
export interface SiteDriftOptions extends SiteWpCliOptions {
  /** Fixed-operation seams for deterministic tests; no arbitrary WP command is exposed. */
  snapshotTransport?: SiteReadTransport;
  templateTransport?: SiteReadTransport;
}

interface BundleManifest {
  formatVersion: number;
  artifactIdentity: string;
  sourceIdentity: string;
  artifactType: 'site' | 'theme';
  bundleFiles: Array<{ path: string; sha256: string; size: number }>;
}

/** Inspect one immutable compiled bundle against one explicit, read-only WordPress target. */
export async function inspectSiteDrift(bundlePath: string, options: SiteDriftOptions): Promise<SiteDriftReport> {
  const input = await readSitePlanInput(bundlePath);
  const absoluteBundle = path.resolve(bundlePath);
  const manifestPath = path.join(absoluteBundle, 'site.manifest.json');
  const manifestBytes = await readStableRegularFile(manifestPath, 'retained bundle manifest changed while reading');
  let manifest: BundleManifest;
  try { manifest = JSON.parse(manifestBytes.content.toString('utf8')) as BundleManifest; }
  catch { throw new Error('retained bundle manifest is invalid JSON'); }
  if (manifest.formatVersion !== 1 || !['site', 'theme'].includes(manifest.artifactType)
    || typeof manifest.artifactIdentity !== 'string' || !manifest.artifactIdentity
    || manifest.sourceIdentity !== input.source.sourceIdentity || !Array.isArray(manifest.bundleFiles)) {
    throw new Error('retained bundle identity is incomplete or inconsistent');
  }
  const source = input.source;
  const sourceFiles = new Map<string, { kind: 'template' | 'part'; entityId: string }>();
  for (const slug of Object.keys(source.sourceIntent.templates)) sourceFiles.set(`theme/templates/${slug}.html`, { kind: 'template', entityId: `${source.sourceIntent.theme.slug}//${slug}` });
  for (const slug of Object.keys(source.sourceIntent.parts)) sourceFiles.set(`theme/parts/${slug}.html`, { kind: 'part', entityId: `${source.sourceIntent.theme.slug}//${slug}` });
  const manifestFiles = new Map(manifest.bundleFiles.map(file => [file.path, file]));
  const expected = new Map<string, { kind: 'template' | 'part'; entityId: string; raw: string; sha256: string }>();
  for (const [filePath, descriptor] of sourceFiles) {
    const entry = manifestFiles.get(filePath);
    if (!entry) throw new Error(`retained bundle omits source theme file ${filePath}`);
    const file = await readStableRegularFile(path.join(absoluteBundle, ...filePath.split('/')), 'retained theme source changed while reading');
    if (file.content.byteLength !== entry.size || hashBytes(file.content) !== entry.sha256) throw new Error(`retained theme source differs from bundle identity for ${filePath}`);
    expected.set(`${descriptor.kind}:${descriptor.entityId}`, { ...descriptor, raw: file.content.toString('utf8'), sha256: hashBytes(file.content) });
  }
  if (manifest.artifactIdentity.length === 0 || manifest.sourceIdentity !== source.sourceIdentity) throw new Error('retained bundle identity changed during inspection');

  let snapshot: SiteSnapshot;
  let templates: SiteTemplateSnapshot;
  try {
    [snapshot, templates] = await Promise.all([
      readSiteSnapshot(options, source.sourceIntent.siteId, options.snapshotTransport),
      readSiteTemplateSnapshot(options, source.sourceIntent.theme.slug, options.templateTransport),
    ]);
  } catch {
    return { version: 1, status: 'blocked', target: null,
      bundle: { siteId: source.sourceIntent.siteId, sourceIdentity: source.sourceIdentity, artifactIdentity: manifest.artifactIdentity },
      findings: [{ kind: 'inspection', status: 'blocked', code: 'wordpress-inspection-incomplete', message: 'WordPress target, principal, permission, transport, or edit-context inspection was incomplete.' }] };
  }
  const initialTarget = targetIdentity(snapshot);
  const templateTarget = targetIdentity(templates);
  const requestedPrincipal = options.wpUser?.trim();
  const requestedPrincipalMatches = !requestedPrincipal || (/^\d+$/.test(requestedPrincipal)
    ? Number(requestedPrincipal) === templates.principal.userId : requestedPrincipal.toLowerCase() === templates.principal.userLogin.toLowerCase());
  if (hashCanonicalJson(initialTarget) !== hashCanonicalJson(templateTarget) || snapshot.theme.slug !== source.sourceIntent.theme.slug
    || templates.theme !== source.sourceIntent.theme.slug || snapshot.theme.slug !== templates.theme
    || snapshot.principal.userId !== templates.principal.userId || !requestedPrincipalMatches || !templates.principal.canReadEditContext) {
    return { version: 1, status: 'blocked', target: { ...initialTarget, theme: snapshot.theme.slug },
      bundle: { siteId: source.sourceIntent.siteId, sourceIdentity: source.sourceIdentity, artifactIdentity: manifest.artifactIdentity },
      findings: [{ kind: 'inspection', status: 'blocked', code: 'target-observation-mismatch', message: 'WordPress target, theme, or principal changed between the required fresh inspections.' }] };
  }
  const report: SiteDriftReport = {
    version: 1,
    status: 'clean',
    target: { ...initialTarget, theme: snapshot.theme.slug },
    bundle: { siteId: source.sourceIntent.siteId, sourceIdentity: source.sourceIdentity, artifactIdentity: manifest.artifactIdentity },
    findings: [],
  };
  const add = (finding: SiteDriftFinding): void => { report.findings.push(finding); };
  if (input.sourceIntentState === 'unreconciled') {
    add({ kind: 'inspection', status: 'equivalent-override', code: 'source-intent-out-of-date',
      message: 'This generated bundle includes adopted theme markup; its retained source intent and design assets are unchanged and require developer reconciliation before planning.' });
  }
  if (snapshot.siteRecord?.operation && (snapshot.siteRecord.operation.status !== 'completed'
    || (snapshot.siteRecord.operation.currentStep && snapshot.siteRecord.operation.currentStep.status !== 'completed'))) {
    add({ kind: 'inspection', status: 'blocked', code: 'outstanding-operation', message: 'An operation is started or has an unknown outcome; reconcile it before drift can be reported clean.' });
  }
  if (snapshot.siteRecord && (snapshot.siteRecord.version !== 1 || snapshot.siteRecord.siteId !== source.sourceIntent.siteId)) {
    add({ kind: 'inspection', status: 'blocked', code: 'invalid-site-record', message: 'The observed ownership record does not match the explicit bundle site identity.' });
  }
  if (snapshot.runtime.wordpress.split('.').slice(0, 2).join('.') !== '7.1') {
    add({ kind: 'inspection', status: 'blocked', code: 'unsupported-wordpress', message: 'WordPress 7.1 is required for this drift observation.' });
  }
  const requiredReadCapabilities = ['edit_pages', 'edit_posts', 'edit_others_pages', 'edit_others_posts'];
  if (Object.keys(snapshot.siteRecord?.options ?? {}).length > 0) requiredReadCapabilities.push('manage_options');
  const missingCapabilities = requiredReadCapabilities.filter(capability => snapshot.principal.capabilities[capability] !== true);
  if (missingCapabilities.length) add({ kind: 'inspection', status: 'blocked', code: 'insufficient-read-capability', message: `The selected WordPress principal cannot verify all managed site state (${missingCapabilities.join(', ')}).` });

  const observedTemplateIds = new Set<string>();
  for (const entity of templates.entities) {
    if (observedTemplateIds.has(`${entity.type}:${entity.id}`)) {
      add({ kind: 'inspection', status: 'blocked', code: 'duplicate-template-id', entityId: entity.id, wpId: entity.wpId, message: 'The REST edit-context response contains duplicate template identity.' });
      continue;
    }
    observedTemplateIds.add(`${entity.type}:${entity.id}`);
    const observedKind = entity.type === 'wp_template_part' ? 'part' : 'template';
    const expectedSource = expected.get(`${observedKind}:${entity.id}`);
    const oppositeSource = expected.get(`${observedKind === 'part' ? 'template' : 'part'}:${entity.id}`);
    if (!expectedSource && oppositeSource) {
      add({ kind: 'inspection', status: 'blocked', entityId: entity.id, wpId: entity.wpId, code: 'template-type-conflict', message: 'The fresh edit-context response maps a source entity ID to the wrong template or part type.' });
      continue;
    }
    if (expectedSource && (expectedSource.kind === 'part' ? entity.type !== 'wp_template_part' : entity.type !== 'wp_template')) {
      add({ kind: 'inspection', status: 'blocked', code: 'template-type-conflict', entityId: entity.id, wpId: entity.wpId, message: 'The observed REST entity type does not match the bundle source path.' });
      continue;
    }
    if (!expectedSource) {
      if (entity.source === 'custom') add({ kind: entity.type === 'wp_template_part' ? 'part' : 'template', status: 'orphaned', entityId: entity.id, wpId: entity.wpId, code: 'unmanaged-theme-override', message: 'A database customization exists for this theme but has no matching source file in the explicit bundle.', observedSha256: hashBytes(Buffer.from(entity.raw, 'utf8')) });
      else if (entity.source === 'plugin') add({ kind: 'dependency', status: 'dependency', entityId: entity.id, code: 'unmanaged-template-source', message: 'A plugin-provided template or part is outside the bundle source mapping and was not expanded.' });
      continue;
    }
    if (entity.source === 'plugin') {
      add({ kind: 'inspection', status: 'blocked', entityId: entity.id, code: 'template-source-conflict', message: 'A bundle-owned source path resolves to a plugin-provided template instead of the active theme or a database customization.' });
      continue;
    }
    const comparison = compareThemeMarkup(expectedSource.raw, entity.raw, snapshot.theme.slug);
    const observedSha256 = hashBytes(Buffer.from(comparison.savedNormalized, 'utf8'));
    const sourceSha256 = hashBytes(Buffer.from(comparison.sourceNormalized, 'utf8'));
    const kind = expectedSource.kind;
    if (entity.source === 'custom' && comparison.equal) {
      add({ kind, status: 'equivalent-override', entityId: entity.id, sourcePath: `theme/${kind === 'part' ? 'parts' : 'templates'}/${entity.id.slice(entity.id.indexOf('//') + 2)}.html`, wpId: entity.wpId, code: 'equivalent-database-override', message: 'A persisted database override is byte-equivalent to the bundle after the existing matching theme-attribute normalization.', sourceSha256, observedSha256 });
    } else if (!comparison.equal) {
      add({ kind, status: 'changed', entityId: entity.id, sourcePath: `theme/${kind === 'part' ? 'parts' : 'templates'}/${entity.id.slice(entity.id.indexOf('//') + 2)}.html`, wpId: entity.source === 'custom' ? entity.wpId : undefined, code: entity.source === 'custom' ? 'changed-database-override' : 'theme-source-differs', message: entity.source === 'custom' ? 'Saved database markup differs from the bundle source after the narrow theme-attribute normalization.' : 'The active theme edit-context markup differs from the exact source file in the bundle.', sourceSha256, observedSha256, ...(comparison.firstDifferenceByte !== undefined ? { firstDifferenceByte: comparison.firstDifferenceByte } : {}) });
    } else {
      add({ kind, status: 'clean', entityId: entity.id, sourcePath: `theme/${kind === 'part' ? 'parts' : 'templates'}/${entity.id.slice(entity.id.indexOf('//') + 2)}.html`, code: 'theme-source-match', message: 'The active theme edit-context markup matches the exact bundle source.', sourceSha256, observedSha256 });
    }
  }
  for (const item of expected.values()) {
    if (!templates.entities.some(entity => entity.id === item.entityId && entity.type === (item.kind === 'part' ? 'wp_template_part' : 'wp_template'))) {
      add({ kind: item.kind, status: 'missing', entityId: item.entityId, sourcePath: `theme/${item.kind === 'part' ? 'parts' : 'templates'}/${item.entityId.slice(item.entityId.indexOf('//') + 2)}.html`, code: 'missing-theme-entity', message: 'The exact source template or part is absent from the fresh edit-context WordPress response.', sourceSha256: item.sha256 });
    }
  }

  const attachmentInspection = inspectManagedEntities(snapshot, source.sourceIntent.siteId, source.sourceIntent.pages.map(page => `page:${page.id}`), Object.keys(source.sourceIntent.syncedPatterns?.definitions ?? {}).map(id => `pattern:${id}`), add);
  inspectManagedOptions(snapshot, add);
  const ownedIds = new Set(snapshot.entities.filter(entity => entity.ownership.some(owner => owner.siteId === source.sourceIntent.siteId && owner.kind === 'pattern' && owner.lastAppliedHash === managedStateHash(entity.state))).map(entity => entity.id));
  for (const entity of snapshot.entities) {
    if (!entity.ownership.some(owner => owner.siteId === source.sourceIntent.siteId) || typeof entity.state.content !== 'string') continue;
    inspectDependencies(entity.state.content, entity, snapshot, ownedIds, attachmentInspection.verified, attachmentInspection.unavailable, add);
  }
  for (const entity of templates.entities) inspectDependencies(entity.raw, undefined, snapshot, ownedIds, attachmentInspection.verified, attachmentInspection.unavailable, add);

  for (const entry of manifest.bundleFiles) {
    const currentFile = await readStableRegularFile(path.join(absoluteBundle, ...entry.path.split('/')), 'retained bundle file changed during drift inspection');
    if (currentFile.content.byteLength !== entry.size || hashBytes(currentFile.content) !== entry.sha256) throw new Error('retained bundle identity changed during drift inspection');
  }
  const currentManifest = await readStableRegularFile(manifestPath, 'retained bundle manifest changed during drift inspection');
  if (!currentManifest.content.equals(manifestBytes.content)) throw new Error('retained bundle identity changed during drift inspection');
  const statuses = report.findings.map(finding => finding.status);
  report.status = statuses.includes('blocked') ? 'blocked' : statuses.some(status => !['clean', 'equivalent-override'].includes(status)) ? 'actionable' : 'clean';
  return report;
}

function targetIdentity(value: Pick<SiteSnapshot, 'target'> | Pick<SiteTemplateSnapshot, 'target'>): SiteSnapshot['target'] {
  return { homeUrl: value.target.homeUrl, siteUrl: value.target.siteUrl, blogId: value.target.blogId };
}

function inspectManagedEntities(snapshot: SiteSnapshot, siteId: string, desiredPages: string[], desiredPatterns: string[], add: (finding: SiteDriftFinding) => void): { verified: Set<number>; unavailable: Set<number> } {
  const record = snapshot.siteRecord;
  const byKey = new Map<string, SiteEntity[]>();
  const attachmentsByKey = new Map<string, SiteEntity[]>();
  const verifiedAttachmentIds = new Set<number>();
  const unavailableAttachmentIds = new Set<number>();
  const allIds = new Set<number>();
  for (const entity of snapshot.entities) {
    if (!Number.isInteger(entity.id) || entity.id < 1 || allIds.has(entity.id)) {
      add({ kind: 'inspection', status: 'blocked', code: 'entity-id-conflict', entityId: String(entity.id), wpId: entity.id, message: 'Observed site entities contain an invalid or duplicate numeric ID.' });
    }
    allIds.add(entity.id);
    for (const owner of entity.ownership) {
      if (owner.siteId !== siteId) continue;
      if (entity.kind === 'attachment') {
        const baselineMatches = managedStateHash(entity.state) === owner.lastAppliedHash;
        const originalSha = owner.assetSha256 ?? (baselineMatches && typeof entity.state.sha256 === 'string' ? entity.state.sha256 : undefined);
        const valid = owner.version === 1 && owner.kind === 'attachment' && Boolean(owner.entityId)
          && /^sha256:[a-f0-9]{64}$/.test(owner.lastAppliedHash)
          && typeof originalSha === 'string' && /^[a-f0-9]{64}$/.test(originalSha);
        if (!valid) {
          add({ kind: 'attachment', status: 'blocked', entityId: `attachment:${owner.entityId}`, wpId: entity.id, code: 'invalid-attachment-baseline', message: 'Owned attachment metadata does not prove an exact logical identity, version, and full original-byte SHA-256 baseline.' });
          continue;
        }
        const key = `attachment:${owner.entityId}@${originalSha}`;
        const matches = attachmentsByKey.get(key) ?? [];
        matches.push(entity); attachmentsByKey.set(key, matches);
        const indexed = record?.entities[key] === entity.id
          || (owner.assetSha256 === undefined && record?.entities[`attachment:${owner.entityId}`] === entity.id);
        if (!baselineMatches || entity.state.sha256 !== originalSha) {
          unavailableAttachmentIds.add(entity.id);
          add({ kind: 'attachment', status: 'changed', entityId: key, wpId: entity.id, code: 'managed-attachment-changed', message: 'The owned attachment original-byte state differs from its complete last-applied baseline.' });
        } else if (entity.postStatus !== 'inherit') {
          unavailableAttachmentIds.add(entity.id);
          add({ kind: 'attachment', status: entity.postStatus === 'trash' ? 'missing' : 'changed', entityId: key, wpId: entity.id, code: 'owned-attachment-unavailable', message: `The owned attachment is unavailable because its observed WordPress status is ${entity.postStatus || 'unknown'}, not inherit.` });
        } else if (!entity.attachment?.currentFileSha256) {
          unavailableAttachmentIds.add(entity.id);
          add({ kind: 'attachment', status: 'missing', entityId: key, wpId: entity.id, code: 'owned-attachment-file-missing', message: 'The owned attachment record exists but its current file is unavailable.' });
        } else if (!indexed) {
          add({ kind: 'attachment', status: 'conflict', entityId: key, wpId: entity.id, code: 'ownership-record-missing', message: 'Owned attachment metadata has no matching version-qualified site-record ID.' });
        } else {
          if (verifiedOwnedAttachment(snapshot, siteId, owner.entityId, originalSha, entity.id)) verifiedAttachmentIds.add(entity.id);
          add({ kind: 'attachment', status: 'clean', entityId: key, wpId: entity.id, code: 'managed-attachment-match', sourceSha256: originalSha, observedSha256: originalSha, message: 'The exact logical attachment version, original-byte SHA-256 baseline, inherited status, and current file are present.' });
        }
        continue;
      }
      const key = `${owner.kind}:${owner.entityId}`;
      const matches = byKey.get(key) ?? [];
      matches.push(entity); byKey.set(key, matches);
      if (owner.version !== 1 || entity.kind !== owner.kind || !owner.entityId || !/^sha256:[a-f0-9]{64}$/.test(owner.lastAppliedHash)) {
        add({ kind: 'inspection', status: 'blocked', entityId: key, wpId: entity.id, code: 'invalid-ownership-baseline', message: 'Owned entity metadata is incomplete or does not match the observed entity type.' });
      } else if (managedStateHash(entity.state) !== owner.lastAppliedHash) {
        add({ kind: entity.kind, status: 'changed', entityId: key, wpId: entity.id, code: 'managed-state-changed', message: 'One or more complete managed fields differ from the last-applied baseline.' });
      } else {
        add({ kind: entity.kind, status: 'clean', entityId: key, wpId: entity.id, code: 'managed-state-match', message: 'All observed managed fields match the complete last-applied state hash.' });
      }
    }
  }
  for (const [key, entities] of byKey) if (entities.length > 1) add({ kind: 'inspection', status: 'conflict', entityId: key, code: 'duplicate-logical-owner', message: 'Multiple WordPress entities claim the same site ownership identity.' });
  const previous = record?.entities ?? {};
  for (const [key, id] of Object.entries(previous)) {
    if (key.startsWith('attachment:')) {
      const version = /^attachment:([^@]+)@([a-f0-9]{64})$/.exec(key);
      const legacy = /^attachment:([^@]+)$/.exec(key);
      const entity = snapshot.entities.find(item => item.id === id && item.kind === 'attachment' && item.ownership.some(owner => {
        if (owner.siteId !== siteId || owner.kind !== 'attachment' || owner.entityId !== (version?.[1] ?? legacy?.[1])) return false;
        if (version) return (owner.assetSha256 ?? (owner.lastAppliedHash === managedStateHash(item.state) ? item.state.sha256 : undefined)) === version[2];
        return Boolean(legacy && owner.assetSha256 === undefined && typeof item.state.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.state.sha256));
      }));
      if (!entity) add({ kind: 'attachment', status: 'missing', entityId: key, wpId: id, code: 'missing-owned-attachment', message: 'A previously managed exact attachment version is absent or its numeric ID/ownership identity changed.' });
      continue;
    }
    const entity = snapshot.entities.find(item => item.id === id && item.ownership.some(owner => owner.siteId === siteId && `${owner.kind}:${owner.entityId}` === key));
    if (!entity) add({ kind: key.startsWith('pattern:') ? 'pattern' : 'page', status: 'missing', entityId: key, wpId: id, code: 'missing-owned-entity', message: 'A previously managed numeric entity ID is absent or its ownership identity changed.' });
    if (!desiredPages.includes(key) && !desiredPatterns.includes(key)) add({ kind: key.startsWith('pattern:') ? 'pattern' : 'page', status: 'orphaned', entityId: key, wpId: id, code: 'orphaned-owned-entity', message: 'A previously managed entity is not declared by the current source bundle.' });
  }
  for (const [key, entities] of byKey) {
    if (!Object.hasOwn(previous, key)) add({ kind: key.startsWith('pattern:') ? 'pattern' : 'page', status: 'conflict', entityId: key, wpId: entities[0]?.id, code: 'ownership-record-missing', message: 'Ownership metadata exists without a matching site record entity baseline.' });
    else if (entities[0]?.id !== previous[key]) add({ kind: 'inspection', status: 'conflict', entityId: key, wpId: entities[0]?.id, code: 'ownership-id-conflict', message: 'Ownership metadata ID differs from the numeric ID in the site record.' });
  }
  for (const [key, entities] of attachmentsByKey) {
    if (entities.length > 1) add({ kind: 'attachment', status: 'conflict', entityId: key, code: 'duplicate-logical-owner', message: 'Multiple attachment records claim the same exact site, logical ID, and original-byte version.' });
  }
  for (const key of [...desiredPages, ...desiredPatterns]) if (Object.hasOwn(previous, key) && !byKey.has(key)) {
    add({ kind: key.startsWith('pattern:') ? 'pattern' : 'page', status: 'missing', entityId: key, wpId: previous[key], code: 'missing-owned-entity', message: 'A previously managed entity is missing from the fresh site snapshot.' });
  }
  if (!record && byKey.size > 0) add({ kind: 'inspection', status: 'blocked', code: 'ownership-baseline-missing', message: 'Owned entities exist but the site baseline record is unavailable.' });
  if (!record && attachmentsByKey.size > 0) add({ kind: 'inspection', status: 'blocked', code: 'ownership-baseline-missing', message: 'Owned attachments exist but the site baseline record is unavailable.' });
  return { verified: verifiedAttachmentIds, unavailable: unavailableAttachmentIds };
}

function inspectManagedOptions(snapshot: SiteSnapshot, add: (finding: SiteDriftFinding) => void): void {
  for (const [name, baseline] of Object.entries(snapshot.siteRecord?.options ?? {})) {
    const equal = hashCanonicalJson(snapshot.options[name]) === hashCanonicalJson(baseline.lastAppliedValue);
    add({ kind: 'option', status: equal ? 'clean' : 'changed', entityId: name, code: equal ? 'managed-option-match' : 'managed-option-changed', message: equal ? 'The explicitly managed option matches its last-applied baseline.' : 'The explicitly managed option differs from its last-applied baseline.' });
  }
}

function inspectDependencies(content: string, owner: SiteEntity | undefined, snapshot: SiteSnapshot, ownedPatternIds: Set<number>, ownedAttachmentIds: Set<number>, unavailableAttachmentIds: Set<number>, add: (finding: SiteDriftFinding) => void): void {
  const blockOpen = /<!--\s*wp:((?:[a-z0-9-]+\/)?[a-z0-9-]+)(?:\s+([^]*?))?\s*\/?-->/g;
  for (const match of content.matchAll(blockOpen)) {
    const name = match[1]!.includes('/') ? match[1]! : `core/${match[1]}`;
    const isImage = name === 'core/image' || name === 'core/cover';
    if (name !== 'core/navigation' && name !== 'core/block' && !isImage) continue;
    const attributesText = (match[2] ?? '').replace(/\s*\/\s*$/, '').trim();
    let attributes: Record<string, unknown> = {};
    if (attributesText) {
      try { attributes = JSON.parse(attributesText) as Record<string, unknown>; }
      catch { add({ kind: 'dependency', status: 'blocked', entityId: owner ? `${owner.kind}:${owner.id}` : undefined, code: 'unreadable-dependency', message: `A ${name} dependency has malformed block-comment attributes.` }); continue; }
    }
    const refKey = isImage ? 'id' : 'ref';
    if (!Object.hasOwn(attributes, refKey)) continue;
    const ref = attributes[refKey];
    if (!Number.isInteger(ref) || (ref as number) < 1) {
      add({ kind: 'dependency', status: 'dependency', entityId: `${name}:invalid`, code: isImage ? 'invalid-attachment-dependency' : 'invalid-dependency-ref', message: `A ${name} reference is not a positive numeric WordPress ID.` });
      continue;
    }
    const id = ref as number;
    const isNavigation = name === 'core/navigation';
    const attachment = isImage ? snapshot.entities.find(item => item.kind === 'attachment' && item.id === id) : undefined;
    const observed = isNavigation ? snapshot.navigation.some(item => item.id === id)
      : isImage ? Boolean(attachment)
        : snapshot.entities.some(item => item.kind === 'pattern' && item.id === id);
    const isOwned = isImage ? ownedAttachmentIds.has(id) : !isNavigation && ownedPatternIds.has(id);
    const isUnavailableOwnedAttachment = isImage && unavailableAttachmentIds.has(id);
    const entityName = isImage ? 'attachment' : name;
    add({ kind: 'dependency', status: observed && isOwned ? 'clean' : 'dependency', entityId: `${name}:${id}`, wpId: id,
      code: !observed ? 'unresolved-dependency' : isNavigation ? 'unowned-navigation-dependency' : isImage ? isOwned ? 'verified-owned-attachment-dependency' : isUnavailableOwnedAttachment ? 'unavailable-attachment-dependency' : 'unowned-attachment-dependency' : isOwned ? 'verified-owned-pattern-dependency' : 'unowned-pattern-dependency',
      message: !observed ? `The referenced ${entityName} entity ID ${id} is not present in the fresh WordPress snapshot.` : isOwned ? `The reference resolves to a verified owned ${entityName}.` : `The referenced ${entityName} entity ID ${id} is resolved but its ownership is not verified; inspection did not expand or adopt it.` });
  }
}
