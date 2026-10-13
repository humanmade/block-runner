import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { hashBytes, readStableRegularFile } from '../publication.js';
import { hashCanonicalJson } from '../proof/receipt.js';
import { verifyPreparedSiteAssets } from './assets.js';
import { attachmentVersionKey } from './media.js';
import { managedStateHash, observedAttachmentBindings, type SitePlanInput } from './plan.js';
import { readSiteSnapshot, siteRecordOption, SITE_OWNERSHIP_META, SITE_APPLY_LOCK_OPTION, type SiteReadTransport, type SiteWpCliOptions } from './wpcli.js';
import type { SitePlan, SiteSnapshot } from './plan-types.js';
import type { PreparedSiteSource, SiteAttachmentBinding } from './types.js';

const run = promisify(execFile);

export interface SiteMediaImportAuthority {
  token: string;
  journalPath: string;
}

export type SiteMediaMutationTransport = (executable: string, args: string[]) => Promise<string>;

export interface ImportPlannedSiteMediaOptions {
  plan: SitePlan;
  source: PreparedSiteSource;
  assetId: string;
  wp: SiteWpCliOptions;
  authority: SiteMediaImportAuthority;
  /** Fixed transport seams for tests; production defaults to local WP-CLI. */
  readTransport?: SiteReadTransport;
  mutationTransport?: SiteMediaMutationTransport;
}

export class SiteMediaImportOutcomeUnknown extends Error {
  readonly status = 'outcome_unknown';
  constructor() {
    super('attachment import outcome is unknown; preserve the journal and reconcile manually before any retry');
    this.name = 'SiteMediaImportOutcomeUnknown';
  }
}

/**
 * Private #171 apply primitive. It accepts only an already confirmed create operation whose
 * started step is durable locally and visible in the selected WordPress site's operation marker.
 */
export async function importPlannedSiteAttachment(options: ImportPlannedSiteMediaOptions): Promise<SiteAttachmentBinding> {
  return (await importAttachment(options)).binding;
}

/** Apply has just verified source and persisted/read back this exact started step. */
export async function importPlannedSiteAttachmentStep(options: ImportPlannedSiteMediaOptions, before: SiteSnapshot): Promise<{ binding: SiteAttachmentBinding; snapshot: SiteSnapshot }> {
  return importAttachment(options, before);
}

async function importAttachment(options: ImportPlannedSiteMediaOptions, verifiedBefore?: SiteSnapshot): Promise<{ binding: SiteAttachmentBinding; snapshot: SiteSnapshot }> {
  const { plan, source, assetId, wp, authority } = options;
  const selected = validateSelectedCreate(plan, source, assetId);
  validateJournalAuthority(plan, selected.asset.id, selected.key, selected.asset.sha256, authority, await readJournal(authority.journalPath));

  // Re-read the entire declared source through the regular-file/no-symlink boundary immediately
  // before the one target mutation attempt.
  if (!verifiedBefore) await verifyPreparedSiteAssets(source);
  const refreshedAsset = source.assets.find(asset => asset.id === assetId);
  if (!refreshedAsset || refreshedAsset.sha256 !== selected.asset.sha256 || hashBytes(Buffer.from(refreshedAsset.bytes)) !== selected.asset.sha256) {
    throw new Error('declared attachment bytes changed after confirmation');
  }

  const routes = plan.snapshot.routing.routes.map(route => route.route);
  const mediaHashIds=plan.snapshot.entities.filter(entity=>entity.kind==='attachment'&&typeof entity.state.sha256==='string').map(entity=>entity.id);
  const before = verifiedBefore ?? await readSiteSnapshot(wp, plan.siteId, options.readTransport, routes, mediaHashIds);
  assertTargetAndMarker(before, plan, selected.key, selected.asset.id, selected.asset.sha256, authority.token);
  if (before.theme.slug !== plan.snapshot.theme.slug
      || hashCanonicalJson(before.theme.inventory) !== hashCanonicalJson(plan.snapshot.theme.inventory)
      || hashCanonicalJson(before.principal) !== hashCanonicalJson(plan.snapshot.principal)) {
    throw new Error('live theme inventory or principal differs from the confirmed plan');
  }
  const input: SitePlanInput = { source, retainedBindings: {} };
  for (const entity of before.entities) {
    if (entity.kind !== 'attachment') continue;
    const owner = entity.ownership.find(meta => meta.siteId === plan.siteId && meta.entityId === assetId);
    if (!owner) continue;
    if (!/^[a-f0-9]{64}$/.test(owner.assetSha256 ?? '')) throw new Error('owned attachment metadata has no source version hash');
    if (owner.assetSha256 === selected.asset.sha256) {
      throw new Error('the exact owned attachment version already exists; reconcile the started operation instead of importing again');
    }
  }
  if (before.siteRecord?.entities[selected.key] !== undefined) throw new Error('site record already indexes the exact attachment version');

  const mutationTransport = options.mutationTransport ?? localMutation;
  let mutationResult: string;
  try {
    mutationResult = await mutationTransport(wp.wpBinary ?? 'wp', mutationArgs(wp, importScript({
      plan,
      assetId,
      assetSha256: selected.asset.sha256,
      assetRoot: source.assetRoot,
      relativePath: selected.asset.path,
      versionKey: selected.key,
      token: authority.token,
    })));
  } catch {
    throw new SiteMediaImportOutcomeUnknown();
  }

  const createdId = parseMutationResult(mutationResult, selected.asset.sha256);
  let after: SiteSnapshot;
  try {
    after = await readSiteSnapshot(wp, plan.siteId, options.readTransport, routes, mediaHashIds);
  } catch {
    throw new SiteMediaImportOutcomeUnknown();
  }
  try {
    if (hashCanonicalJson(after.target) !== hashCanonicalJson(plan.snapshot.target)
        || hashCanonicalJson(after.theme.inventory) !== hashCanonicalJson(before.theme.inventory)
        || after.theme.slug !== plan.snapshot.theme.slug) throw new Error('target or theme inventory changed');
    const bindings = observedAttachmentBindings(input, after);
    const binding = bindings[assetId];
    const exactEntity = after.entities.find(entity => entity.kind === 'attachment' && entity.id === createdId);
    const matchingIds = after.entities.filter(entity => entity.id === createdId);
    const exactOwner = exactEntity?.ownership.find(meta => meta.siteId === plan.siteId && meta.entityId === assetId
      && meta.assetSha256 === selected.asset.sha256 && meta.kind === 'attachment');
    if (!binding || binding.id !== createdId || matchingIds.length !== 1 || !exactEntity || exactEntity.postStatus !== 'inherit' || exactEntity.ownership.length !== 1 || exactEntity.state.sha256 !== selected.asset.sha256
        || !exactOwner || exactOwner.lastAppliedHash !== managedStateHash(exactEntity.state)
        || !exactEntity.attachment?.sizes?.full || typeof exactEntity.attachment.url !== 'string') throw new Error('new attachment does not match its declared version and native metadata');
    return { binding, snapshot: after };
  } catch {
    throw new SiteMediaImportOutcomeUnknown();
  }
}

interface SelectedCreate { asset: PreparedSiteSource['assets'][number]; key: string }

function validateSelectedCreate(plan: SitePlan, source: PreparedSiteSource, assetId: string): SelectedCreate {
  if (!plan.executable || plan.conflicts.length > 0 || plan.siteId !== source.sourceIntent.siteId || plan.sourceIdentity !== source.sourceIdentity) {
    throw new Error('confirmed plan does not match the prepared site source');
  }
  const { confirmationHash, ...body } = plan;
  if (hashCanonicalJson(body) !== confirmationHash || hashCanonicalJson(plan.snapshot) !== plan.snapshotFingerprint) {
    throw new Error('confirmed plan integrity check failed');
  }
  if (plan.snapshot.siteRecord?.operation && plan.snapshot.siteRecord.operation.status !== 'completed') {
    throw new Error('plan was produced while a prior site operation was unresolved');
  }
  const declarations = source.sourceIntent.assets.filter(asset => asset.id === assetId && asset.role === 'attachment' && asset.kind === 'image');
  const prepared = source.assets.filter(asset => asset.id === assetId && asset.role === 'attachment' && asset.kind === 'image');
  const planned = plan.assets.filter(asset => asset.id === assetId);
  const versionOps = plan.operations.filter(operation => operation.kind === 'attachment' && operation.entityId === assetId);
  const createOps = versionOps.filter(operation => operation.action === 'create');
  if (declarations.length !== 1 || prepared.length !== 1 || planned.length !== 1 || createOps.length !== 1
      || versionOps.some(operation => operation.action !== 'create' && operation.action !== 'retain')
      || planned[0]!.path !== declarations[0]!.path || planned[0]!.sha256 !== prepared[0]!.sha256
      || createOps[0]!.desired?.sha256 !== prepared[0]!.sha256
      || createOps[0]!.desired?.assetSha256 !== prepared[0]!.sha256) {
    throw new Error('plan has no unique create operation for the exact declared attachment version');
  }
  return { asset: prepared[0]!, key: attachmentVersionKey(assetId, prepared[0]!.sha256) };
}

async function readJournal(file: string): Promise<Record<string, unknown>> {
  if (!path.isAbsolute(file) || file.includes('\0')) throw new Error('journal path must be an explicit absolute path');
  const { content } = await readStableRegularFile(file, 'started site journal is absent, unsafe, or changed while reading');
  let value: unknown;
  try { value = JSON.parse(content.toString('utf8')); } catch { throw new Error('started site journal is not valid JSON'); }
  if (!isRecord(value)) throw new Error('started site journal has an invalid shape');
  return value;
}

function validateJournalAuthority(plan: SitePlan, entityId: string, expectedKey: string, sha256: string, authority: SiteMediaImportAuthority, journal: Record<string, unknown>): void {
  if (expectedKey !== attachmentVersionKey(entityId, sha256)) throw new Error('selected attachment version key is inconsistent');
  const expectedStep = { key: expectedKey, kind: 'attachment', entityId, assetSha256: sha256, status: 'started' };
  const expectedTarget = plan.snapshot.target;
  if (journal.version !== 1 || journal.siteId !== plan.siteId || journal.planHash !== plan.confirmationHash
      || journal.token !== authority.token || typeof authority.token !== 'string' || authority.token.length === 0
      || journal.status !== 'started' || journal.principalId !== plan.snapshot.principal.userId
      || !isRecord(journal.target) || !isRecord(journal.currentStep)
      || hashCanonicalJson(journal.target) !== hashCanonicalJson(expectedTarget)
      || hashCanonicalJson(journal.currentStep) !== hashCanonicalJson(expectedStep)) {
    throw new Error('durable started journal does not authorize this exact target, plan, principal, and attachment version');
  }
}

function assertTargetAndMarker(snapshot: SiteSnapshot, plan: SitePlan, key: string, entityId: string, sha256: string, token: string): void {
  const operation = snapshot.siteRecord?.operation;
  const step = operation?.currentStep;
  if (hashCanonicalJson(snapshot.target) !== hashCanonicalJson(plan.snapshot.target)
      || snapshot.siteRecord?.siteId !== plan.siteId || !operation || operation.status !== 'started'
      || operation.token !== token || operation.planHash !== plan.confirmationHash
      || !step || hashCanonicalJson(step) !== hashCanonicalJson({ key, kind: 'attachment', entityId, assetSha256: sha256, status: 'started' })) {
    throw new Error('live site marker does not match the durable started attachment step');
  }
}

function parseMutationResult(output: string, sha256: string): number {
  let result: unknown;
  try { result = JSON.parse(output); } catch { throw new SiteMediaImportOutcomeUnknown(); }
  if (!isRecord(result)) throw new SiteMediaImportOutcomeUnknown();
  if (result.status === 'refused') throw new Error('WordPress refused the attachment import before mutation');
  if (result.status !== 'complete' || result.sha256 !== sha256 || !Number.isSafeInteger(result.id) || Number(result.id) < 1) {
    throw new SiteMediaImportOutcomeUnknown();
  }
  return Number(result.id);
}

function importScript(input: {
  plan: SitePlan;
  assetId: string;
  assetSha256: string;
  assetRoot: string;
  relativePath: string;
  versionKey: string;
  token: string;
}): string {
  const snapshot = input.plan.snapshot;
  const expected = {
    target: snapshot.target,
    principalId: snapshot.principal.userId,
    capabilities: snapshot.principal.capabilities,
    themeSlug: snapshot.theme.slug,
    siteId: input.plan.siteId,
    planHash: input.plan.confirmationHash,
    token: input.token,
    versionKey: input.versionKey,
    entityId: input.assetId,
    assetSha256: input.assetSha256,
    assetRoot: input.assetRoot,
    relativePath: input.relativePath,
    recordOption: siteRecordOption(input.plan.siteId),
    lockOption: SITE_APPLY_LOCK_OPTION,
  };
  const encoded = Buffer.from(JSON.stringify(expected)).toString('base64');
  return `
$expected = json_decode(base64_decode('${encoded}'), true);
$attempted = false;
$result = (function() use ($expected, &$attempted) {
  try {
    $target = array('homeUrl'=>home_url(), 'siteUrl'=>site_url(), 'blogId'=>(int)get_current_blog_id());
    if (wp_json_encode($target) !== wp_json_encode($expected['target'])) return array('status'=>'refused');
    if ((int)get_current_user_id() !== (int)$expected['principalId']) return array('status'=>'refused');
    foreach ($expected['capabilities'] as $capability=>$allowed) if ((bool)current_user_can($capability) !== (bool)$allowed) return array('status'=>'refused');
    if (get_stylesheet() !== $expected['themeSlug']) return array('status'=>'refused');
    if (get_option($expected['lockOption'], null) !== $expected['token']) return array('status'=>'refused');
    $record = get_option($expected['recordOption'], null);
    $operation = is_array($record) ? ($record['operation'] ?? null) : null;
    $step = is_array($operation) ? ($operation['currentStep'] ?? null) : null;
    if (!is_array($record) || ($record['siteId'] ?? null) !== $expected['siteId']
      || !is_array($operation) || ($operation['token'] ?? null) !== $expected['token']
      || ($operation['planHash'] ?? null) !== $expected['planHash'] || ($operation['status'] ?? null) !== 'started'
      || !is_array($step) || ($step['key'] ?? null) !== $expected['versionKey']
      || ($step['kind'] ?? null) !== 'attachment' || ($step['entityId'] ?? null) !== $expected['entityId']
      || ($step['assetSha256'] ?? null) !== $expected['assetSha256'] || ($step['status'] ?? null) !== 'started') return array('status'=>'refused');

    $root = realpath($expected['assetRoot']);
    if (!$root || !is_dir($root)) return array('status'=>'refused');
    $cursor = $root;
    foreach (explode('/', $expected['relativePath']) as $part) {
      $cursor = $cursor . DIRECTORY_SEPARATOR . $part;
      if (is_link($cursor)) return array('status'=>'refused');
    }
    $file = realpath($cursor);
    if (!$file || !str_starts_with($file, rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR) || !is_file($file)) return array('status'=>'refused');
    $bytes = file_get_contents($file);
    if ($bytes === false || !hash_equals($expected['assetSha256'], hash('sha256', $bytes))) return array('status'=>'refused');

    foreach (get_posts(array('post_type'=>'attachment', 'post_status'=>array('inherit','private','trash'), 'numberposts'=>-1, 'orderby'=>'ID', 'order'=>'ASC', 'suppress_filters'=>true)) as $existing) {
      $owned = get_post_meta($existing->ID, '${SITE_OWNERSHIP_META}', true);
      if (!is_array($owned) || ($owned['siteId'] ?? null) !== $expected['siteId'] || ($owned['entityId'] ?? null) !== $expected['entityId']) continue;
      if (!isset($owned['assetSha256']) || !is_string($owned['assetSha256']) || !preg_match('/^[a-f0-9]{64}$/', $owned['assetSha256'])) return array('status'=>'refused');
      if (($owned['assetSha256'] ?? null) === $expected['assetSha256']) return array('status'=>'refused');
    }

    $attempted = true;
    $filename = basename($expected['relativePath']);
    $upload = wp_upload_bits($filename, null, $bytes);
    if (!is_array($upload) || !empty($upload['error']) || empty($upload['file']) || empty($upload['url'])) throw new Exception('upload');
    if (!is_file($upload['file']) || is_link($upload['file']) || !hash_equals($expected['assetSha256'], hash_file('sha256', $upload['file']))) throw new Exception('uploaded bytes');
    $type = wp_check_filetype($filename);
    if (empty($type['type'])) throw new Exception('file type');
    $attachmentId = wp_insert_attachment(array('post_mime_type'=>$type['type'], 'post_title'=>sanitize_file_name(pathinfo($filename, PATHINFO_FILENAME)), 'post_status'=>'inherit'), $upload['file'], 0, true);
    if (is_wp_error($attachmentId) || !is_numeric($attachmentId) || (int)$attachmentId < 1) throw new Exception('attachment insert');
    $metadata = wp_generate_attachment_metadata((int)$attachmentId, $upload['file']);
    if (is_wp_error($metadata) || !is_array($metadata) || !$metadata) throw new Exception('attachment metadata');
    wp_update_attachment_metadata((int)$attachmentId, $metadata);
    $original = wp_get_original_image_path((int)$attachmentId); if (!$original) $original = get_attached_file((int)$attachmentId);
    if (!$original || !is_file($original) || is_link($original) || !hash_equals($expected['assetSha256'], hash_file('sha256', $original))) throw new Exception('original-byte readback');
    $state = array('sha256'=>$expected['assetSha256']);
    $ownership = array('version'=>1, 'siteId'=>$expected['siteId'], 'entityId'=>$expected['entityId'], 'kind'=>'attachment',
      'lastAppliedHash'=>'sha256:' . hash('sha256', wp_json_encode($state)), 'assetSha256'=>$expected['assetSha256']);
    if (!add_post_meta((int)$attachmentId, '${SITE_OWNERSHIP_META}', $ownership, true)) throw new Exception('ownership write');
    $stored = get_post_meta((int)$attachmentId, '${SITE_OWNERSHIP_META}', true);
    if (!is_array($stored) || ($stored['siteId'] ?? null) !== $expected['siteId'] || ($stored['entityId'] ?? null) !== $expected['entityId']
      || ($stored['kind'] ?? null) !== 'attachment' || ($stored['assetSha256'] ?? null) !== $expected['assetSha256']
      || ($stored['lastAppliedHash'] ?? null) !== $ownership['lastAppliedHash']) throw new Exception('ownership readback');
    return array('status'=>'complete', 'id'=>(int)$attachmentId, 'sha256'=>$expected['assetSha256']);
  } catch (Throwable $error) {
    return array('status'=>$attempted ? 'outcome_unknown' : 'refused');
  }
})();
echo wp_json_encode($result);
`;
}

function mutationArgs(options: SiteWpCliOptions, script: string): string[] {
  if (!options.wpPath || options.wpPath.includes('\0')) throw new Error('wpPath is required');
  const args = [`--path=${options.wpPath}`];
  for (const value of [options.wpUrl, options.wpUser, options.wpBinary]) if (value?.includes('\0')) throw new Error('WP-CLI arguments cannot contain NUL bytes');
  if (options.wpUrl) args.push(`--url=${options.wpUrl}`);
  if (options.wpUser) args.push(`--user=${options.wpUser}`);
  args.push('eval', script);
  return args;
}

async function localMutation(executable: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(executable, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    return stdout;
  } catch {
    throw new Error('WP-CLI attachment mutation transport failed');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
