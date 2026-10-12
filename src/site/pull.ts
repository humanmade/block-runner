import { randomUUID } from 'node:crypto';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validate } from '../gate/validate.js';
import { parseMarkup } from '../headless/wp.js';
import { hashCanonicalJson } from '../proof/receipt.js';
import { compareThemeMarkup, removeThemeAttributes } from '../proof/theme.js';
import {
  hashBytes, publishStagedFile, readStableRegularFile,
  replacePublicationJournal, stagePublicationBytes,
} from '../publication.js';
import { findThemeReferenceIssues } from '../theme/references.js';
import { discoverThemeMarkupFiles } from '../theme/folders.js';
import { validateThemeJson } from '../theme/theme-json.js';
import type { ReportItem } from '../types.js';
import { readSitePlanInput } from './plan.js';
import { readSiteSnapshot, readSiteTemplateSnapshot, type SiteReadTransport, type SiteWpCliOptions } from './wpcli.js';

const MAX_SELECTED_FILES = 32;
const MAX_MARKUP_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const PLAN_FILE = 'site-pull.plan.json';
const JOURNAL_FILE = 'site-pull.journal.json';

export interface SitePullSelection {
  kind: 'template' | 'part';
  entityId: string;
  wpId: number;
}

export interface SitePullOptions extends SiteWpCliOptions {
  snapshotTransport?: SiteReadTransport;
  templateTransport?: SiteReadTransport;
  /** Fault-injection seam for bounded publication tests. */
  onBeforePublish?: (relativePath: string, index: number) => void | Promise<void>;
}

export interface SitePullResult {
  ok: boolean;
  mode: 'preview' | 'confirm';
  directory: string;
  confirmationHash?: string;
  noOp?: boolean;
  files: Array<{ path: string; beforeSha256: string; afterSha256: string; changed: boolean }>;
  diagnostics: ReportItem[];
  completed?: string[];
  pending?: string[];
  journal?: string;
}

interface PullManifest {
  formatVersion: number;
  artifactIdentity: string;
  sourceIdentity: string;
  artifactType: 'site' | 'theme';
  siteId: string;
  sourceIntentState?: 'unreconciled';
  bundleFiles: Array<{ path: string; sha256: string; size: number }>;
  inventory?: Array<{ path: string; sha256: string; size: number }>;
  [key: string]: unknown;
}

interface PullFile {
  path: string;
  beforeSha256: string;
  beforeSize: number;
  afterSha256: string;
  afterSize: number;
  changed: boolean;
}

interface PullPlanBody {
  version: 1;
  bundlePath: string;
  siteId: string;
  sourceIdentity: string;
  artifactIdentity: string;
  target: { homeUrl: string; siteUrl: string; blogId: number; theme: string };
  principal: { userId: number; userLogin: string };
  selections: Array<SitePullSelection & { sourcePath: string; raw: string; rawSha256: string; normalizedSha256: string }>;
  snapshotFingerprint: string;
  templateSnapshotFingerprint: string;
  manifestBeforeSha256: string;
  manifestAfterSha256: string;
  manifestAfterContent: string;
  files: PullFile[];
  diagnostics: ReportItem[];
  noOp: boolean;
}

interface StoredPullPlan { body: PullPlanBody; confirmationHash: string }
interface PullJournal { version: 1; status: 'started' | 'partial' | 'outcome_unknown' | 'completed'; planHash: string; completed: string[]; pending: string[]; previewDirectory: string; error?: string }

export class SitePullPublicationError extends Error {
  readonly completed: string[];
  readonly pending: string[];
  readonly journal: string;
  constructor(message: string, completed: string[], pending: string[], journal: string) {
    super(`${message}; completed ${completed.length}, pending ${pending.length}; journal retained at ${journal}`);
    this.name = 'SitePullPublicationError';
    this.completed = completed;
    this.pending = pending;
    this.journal = journal;
  }
}

/** Read, gate and stage selected custom theme entities in a new private preview directory. */
export async function previewSitePull(
  bundlePath: string,
  outputDirectory: string,
  selections: readonly SitePullSelection[],
  options: SitePullOptions,
): Promise<SitePullResult> {
  const body = await buildPullPlan(bundlePath, selections, options);
  if (body.diagnostics.some(item => item.status === 'invalid')) {
    return { ok: false, mode: 'preview', directory: path.resolve(outputDirectory), files: body.files, diagnostics: body.diagnostics };
  }
  const target = path.resolve(outputDirectory);
  if (isWithin(target, body.bundlePath) || isWithin(body.bundlePath, target)) throw new Error('pull preview directory must be outside the retained source bundle');
  await assertSafeDirectoryParent(path.dirname(target));
  try { await mkdir(target, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`pull preview directory already exists: ${target}`);
    throw error;
  }
  try {
    await writePrivateFile(path.join(target, 'before/site.manifest.json'), await readBundleFile(body.bundlePath, 'site.manifest.json'));
    await writePrivateFile(path.join(target, 'after/site.manifest.json'), Buffer.from(body.manifestAfterContent, 'utf8'));
    for (const file of body.files) {
      await writePrivateFile(path.join(target, 'before', ...file.path.split('/')), await readBundleFile(body.bundlePath, file.path));
      const selected = body.selections.find(selection => selection.sourcePath === file.path)!;
      const after = file.changed ? removeThemeAttributes(selected.raw, body.target.theme) : (await readBundleFile(body.bundlePath, file.path)).toString('utf8');
      await writePrivateFile(path.join(target, 'after', ...file.path.split('/')), Buffer.from(after, 'utf8'));
    }
    await writePrivateFile(path.join(target, PLAN_FILE), Buffer.from(`${JSON.stringify({ body, confirmationHash: hashCanonicalJson(body) }, null, 2)}\n`));
  } catch (error) {
    throw new Error(`pull preview staging failed; retained at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, mode: 'preview', directory: target, confirmationHash: hashCanonicalJson(body), noOp: body.noOp, files: body.files, diagnostics: body.diagnostics };
}

/** Re-inspect the exact preview and publish its selected files plus updated sealed manifest. */
export async function confirmSitePull(
  bundlePath: string,
  outputDirectory: string,
  confirmationHash: string,
  options: SitePullOptions,
): Promise<SitePullResult> {
  if (!/^sha256:[a-f0-9]{64}$/.test(confirmationHash)) throw new Error('pull confirmation must be the exact sha256:<lowercase-hex> plan hash');
  const directory = path.resolve(outputDirectory);
  await assertSafeDirectoryParent(directory);
  const storedBytes = await readStableRegularFile(path.join(directory, PLAN_FILE), 'pull preview plan is missing, unsafe, or changed');
  let stored: StoredPullPlan;
  try { stored = JSON.parse(storedBytes.content.toString('utf8')) as StoredPullPlan; }
  catch { throw new Error('pull preview plan is invalid JSON'); }
  if (!stored || stored.body?.version !== 1 || hashCanonicalJson(stored.body) !== stored.confirmationHash
    || stored.confirmationHash !== confirmationHash || stored.body.bundlePath !== path.resolve(bundlePath)) throw new Error('pull confirmation does not match the staged plan and retained bundle');
  const refreshed = await buildPullPlan(stored.body.bundlePath, stored.body.selections, options);
  const refreshedHash = hashCanonicalJson(refreshed);
  if (refreshedHash !== confirmationHash) throw new Error('pull source, target, selected WordPress entities, or local before-bytes changed after preview');
  if (refreshed.diagnostics.some(item => item.status === 'invalid')) throw new Error('pull validation no longer passes; no source files were published');
  if (refreshed.noOp) return { ok: true, mode: 'confirm', directory, confirmationHash, noOp: true, files: refreshed.files, diagnostics: refreshed.diagnostics };
  await verifyPreviewStage(directory, refreshed);

  const journalPath = path.join(directory, JOURNAL_FILE);
  const entries = [...refreshed.files.filter(file => file.changed).map(file => file.path), 'site.manifest.json'];
  const completed: string[] = [];
  const pending = [...entries];
  const journal: PullJournal = { version: 1, status: 'started', planHash: confirmationHash, completed, pending, previewDirectory: directory };
  try { await createInitialJournal(journalPath, journal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('pull journal already exists; reconcile the retained partial publication before another confirmation');
    throw error;
  }
  for (let index = 0; index < entries.length; index++) {
    const relative = entries[index]!;
    try {
      await options.onBeforePublish?.(relative, index);
      await publishOne(directory, refreshed, relative, index === entries.length - 1);
      completed.push(relative);
      pending.shift();
      journal.status = pending.length ? 'started' : 'completed';
      await replacePublicationJournal(journalPath, journal);
    } catch (error) {
      const state = await classifyTarget(refreshed.bundlePath, directory, relative);
      if (state === 'after' && !completed.includes(relative)) {
        completed.push(relative);
        pending.shift();
      }
      journal.status = state === 'unknown' ? 'outcome_unknown' : 'partial';
      journal.error = error instanceof Error ? error.message : String(error);
      try { await replacePublicationJournal(journalPath, journal); } catch { journal.status = 'outcome_unknown'; }
      throw new SitePullPublicationError(journal.error, completed, pending, journalPath);
    }
  }
  return { ok: true, mode: 'confirm', directory, confirmationHash, files: refreshed.files, diagnostics: refreshed.diagnostics, completed, pending, journal: journalPath };
}

async function buildPullPlan(bundlePath: string, selections: readonly SitePullSelection[], options: SitePullOptions): Promise<PullPlanBody> {
  if (selections.length < 1 || selections.length > MAX_SELECTED_FILES) throw new Error(`select between 1 and ${MAX_SELECTED_FILES} template or part entities`);
  const seen = new Set<string>();
  for (const selection of selections) {
    if (!['template', 'part'].includes(selection.kind) || !Number.isInteger(selection.wpId) || selection.wpId < 1
      || typeof selection.entityId !== 'string' || !selection.entityId) throw new Error('each selection needs an exact kind, theme entity ID and positive WordPress ID');
    const key = `${selection.kind}:${selection.entityId}:${selection.wpId}`;
    if (seen.has(key)) throw new Error(`duplicate pull selection ${key}`);
    seen.add(key);
  }
  const absoluteBundle = path.resolve(bundlePath);
  const input = await readSitePlanInput(absoluteBundle);
  const manifestBefore = await readStableRegularFile(path.join(absoluteBundle, 'site.manifest.json'), 'retained site manifest changed while preparing pull');
  if (manifestBefore.content.byteLength > MAX_MANIFEST_BYTES) throw new Error(`site manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const manifest = parseManifest(manifestBefore.content);
  if (manifest.siteId !== input.source.sourceIntent.siteId || manifest.sourceIdentity !== input.source.sourceIdentity
    || !['site', 'theme'].includes(manifest.artifactType) || !manifest.artifactIdentity) throw new Error('pull requires one intact generated site or theme bundle');
  const theme = input.source.sourceIntent.theme.slug;
  const targetFiles = mapSourceFiles(input.source.sourceIntent.templates, input.source.sourceIntent.parts, theme);
  const [snapshot, templateSnapshot] = await Promise.all([
    readSiteSnapshot(options, input.source.sourceIntent.siteId, options.snapshotTransport),
    readSiteTemplateSnapshot(options, theme, options.templateTransport),
  ]);
  const principal = templateSnapshot.principal;
  const requestedPrincipal = options.wpUser?.trim();
  const requestedPrincipalMatches = !requestedPrincipal || (/^\d+$/.test(requestedPrincipal)
    ? Number(requestedPrincipal) === principal.userId : requestedPrincipal.toLowerCase() === principal.userLogin.toLowerCase());
  if (snapshot.target.homeUrl !== templateSnapshot.target.homeUrl || snapshot.target.siteUrl !== templateSnapshot.target.siteUrl
    || snapshot.target.blogId !== templateSnapshot.target.blogId || snapshot.theme.slug !== theme || templateSnapshot.theme !== theme
    || snapshot.principal.userId !== principal.userId || !principal.canReadEditContext || !requestedPrincipalMatches
    || !/^7\.1(?:\.|$)/.test(snapshot.runtime.wordpress) || !/^7\.1(?:\.|$)/.test(templateSnapshot.runtime.wordpress)) {
    throw new Error('pull target, active theme, WordPress version, or principal changed or is not authorised for edit-context inspection');
  }
  if (snapshot.siteRecord && (snapshot.siteRecord.version !== 1 || snapshot.siteRecord.siteId !== input.source.sourceIntent.siteId)) throw new Error('pull site record belongs to a different site identity');
  if (snapshot.siteRecord?.operation && (snapshot.siteRecord.operation.status !== 'completed'
    || (snapshot.siteRecord.operation.currentStep && snapshot.siteRecord.operation.currentStep.status !== 'completed'))) {
    throw new Error('pull refuses an outstanding started or unknown site operation');
  }
  const remoteByIdentity = new Map(templateSnapshot.entities.map(entity => [`${entity.type}:${entity.id}`, entity]));
  const selected: PullPlanBody['selections'] = [];
  const beforeFiles = new Map<string, Buffer>();
  const afterFiles = new Map<string, Buffer>();
  const diagnostics: ReportItem[] = [];
  let totalBytes = 0;
  for (const selection of selections) {
    const wpType = selection.kind === 'part' ? 'wp_template_part' : 'wp_template';
    const sourcePath = targetFiles.get(`${selection.kind}:${selection.entityId}`);
    if (!sourcePath) throw new Error(`selected ${selection.kind} entity ${selection.entityId} has no exact source mapping in retained SiteIntent`);
    const observed = remoteByIdentity.get(`${wpType}:${selection.entityId}`);
    if (!observed || observed.wpId !== selection.wpId || observed.source !== 'custom' || observed.theme !== theme) throw new Error(`selected WordPress entity ${wpType}:${selection.entityId}:${selection.wpId} is not the exact active-theme custom entity`);
    const inventoryEntry = manifest.bundleFiles.find(entry => entry.path === sourcePath);
    if (!inventoryEntry) throw new Error(`retained manifest omits selected source file ${sourcePath}`);
    const before = await readBundleFile(absoluteBundle, sourcePath);
    if (before.byteLength !== inventoryEntry.size || hashBytes(before) !== inventoryEntry.sha256) throw new Error(`selected local source file differs from its sealed manifest: ${sourcePath}`);
    const rawBytes = Buffer.from(observed.raw, 'utf8');
    const normalized = Buffer.from(removeThemeAttributes(observed.raw, theme), 'utf8');
    if (rawBytes.byteLength > MAX_MARKUP_BYTES || normalized.byteLength > MAX_MARKUP_BYTES) throw new Error(`selected saved markup exceeds ${MAX_MARKUP_BYTES} bytes: ${sourcePath}`);
    totalBytes += rawBytes.byteLength;
    if (totalBytes > MAX_BATCH_BYTES) throw new Error(`selected saved markup exceeds ${MAX_BATCH_BYTES} bytes in total`);
    const equal = compareThemeMarkup(before.toString('utf8'), observed.raw, theme).equal;
    const after = equal ? before : normalized;
    beforeFiles.set(sourcePath, before);
    afterFiles.set(sourcePath, after);
    selected.push({ ...selection, sourcePath, raw: observed.raw, rawSha256: hashBytes(rawBytes), normalizedSha256: hashBytes(normalized) });
  }
  const gateDiagnostics = await validateProspectiveTheme(absoluteBundle, manifest, beforeFiles, afterFiles);
  diagnostics.push(...gateDiagnostics);
  const files: PullFile[] = [...beforeFiles].map(([filePath, before]) => {
    const after = afterFiles.get(filePath)!;
    return { path: filePath, beforeSha256: hashBytes(before), beforeSize: before.length, afterSha256: hashBytes(after), afterSize: after.length, changed: !before.equals(after) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const changed = files.filter(file => file.changed);
  const manifestAfter = updateManifest(manifest, changed);
  const manifestAfterBytes = Buffer.from(`${JSON.stringify(manifestAfter, null, 2)}\n`, 'utf8');
  if (manifestAfterBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error(`prospective site manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const finalInput = await readSitePlanInput(absoluteBundle);
  const finalManifest = await readStableRegularFile(path.join(absoluteBundle, 'site.manifest.json'), 'retained site manifest changed while preparing pull');
  if (finalInput.source.sourceIdentity !== input.source.sourceIdentity || !finalManifest.content.equals(manifestBefore.content)) {
    throw new Error('retained bundle changed while the pull plan was being prepared');
  }
  for (const file of files) {
    const current = await readBundleFile(absoluteBundle, file.path);
    if (hashBytes(current) !== file.beforeSha256 || current.byteLength !== file.beforeSize) throw new Error(`selected local source changed while the pull plan was being prepared: ${file.path}`);
  }
  return {
    version: 1,
    bundlePath: absoluteBundle,
    siteId: input.source.sourceIntent.siteId,
    sourceIdentity: input.source.sourceIdentity,
    artifactIdentity: manifest.artifactIdentity,
    target: { homeUrl: snapshot.target.homeUrl, siteUrl: snapshot.target.siteUrl, blogId: snapshot.target.blogId, theme },
    principal: { userId: principal.userId, userLogin: principal.userLogin },
    selections: selected,
    snapshotFingerprint: hashCanonicalJson(snapshot),
    templateSnapshotFingerprint: hashCanonicalJson(templateSnapshot),
    manifestBeforeSha256: hashBytes(manifestBefore.content),
    manifestAfterSha256: hashBytes(manifestAfterBytes),
    manifestAfterContent: manifestAfterBytes.toString('utf8'),
    files,
    diagnostics,
    noOp: changed.length === 0,
  };
}

async function validateProspectiveTheme(bundle: string, manifest: PullManifest, before: Map<string, Buffer>, after: Map<string, Buffer>): Promise<ReportItem[]> {
  const themeRoot = path.join(bundle, 'theme');
  const files = await discoverThemeMarkupFiles(themeRoot);
  if (files.some(file => file.skipReason === 'theme-unsafe-target')) throw new Error('theme bundle contains a symbolic link or unsafe markup target');
  const inventoryPaths = new Set(manifest.bundleFiles.map(entry => entry.path));
  for (const file of files) {
    const manifestPath = `theme/${file.file}`;
    if (!inventoryPaths.has(manifestPath)) throw new Error(`theme markup is not recorded in the bundle inventory: ${manifestPath}`);
    if (after.has(manifestPath)) {
      const content = after.get(manifestPath)!.toString('utf8');
      file.content = content;
      file.markup = content;
    }
  }
  for (const sourcePath of before.keys()) if (!files.some(file => `theme/${file.file}` === sourcePath)) throw new Error(`selected source is not discovered as a theme template or part: ${sourcePath}`);
  const themeJson = await readBundleFile(bundle, 'theme/theme.json').catch(() => undefined);
  if (!themeJson || !inventoryPaths.has('theme/theme.json')) throw new Error('retained theme bundle has no sealed theme.json');
  const checkedTheme = validateThemeJson(themeJson.toString('utf8'), path.join(themeRoot, 'theme.json'), 'validate');
  const diagnostics: ReportItem[] = [...checkedTheme.report.items];
  for (const file of files) {
    if (file.skipReason) continue;
    const report = await validate(file.markup, { sourcePath: file.path });
    diagnostics.push(...report.items);
    if (!report.ok && !report.items.some(item => item.status === 'invalid')) {
      diagnostics.push({ status: 'invalid', code: 'strict-block-gate', reason: 'strict block validation rejected warnings in the prospective theme file', source: { path: file.path } });
    }
  }
  if (checkedTheme.parsed !== undefined) {
    const references = await findThemeReferenceIssues(themeRoot, files, checkedTheme.parsed);
    diagnostics.push(...references.map(item => item.status === 'warning' && item.severity !== 'info'
      ? { ...item, status: 'invalid' as const, code: item.code ?? 'theme-reference' } : item));
  }
  const selectedAfter = [...after.entries()].filter(([filePath, content]) => !before.get(filePath)?.equals(content));
  for (const [filePath, bytes] of selectedAfter) {
    const markup = bytes.toString('utf8');
    const blocks = await parseMarkup(markup);
    const visit = (nodes: typeof blocks): void => nodes.forEach(block => {
      if (block.name === 'core/navigation' && block.attributes?.ref !== undefined) diagnostics.push({ status: 'invalid', code: 'unsupported-navigation-dependency', block: block.name,
        reason: 'saved navigation references an external wp_navigation record; pull does not inline or adopt that database dependency', source: { path: filePath } });
      if (block.name === 'core/block' && block.attributes?.ref !== undefined) diagnostics.push({ status: 'invalid', code: 'unsupported-synced-pattern-dependency', block: block.name,
        reason: 'saved synced-pattern references require a declared supported source representation; pull does not adopt unowned database graphs', source: { path: filePath } });
      visit(block.innerBlocks ?? []);
    });
    visit(blocks);
  }
  return diagnostics;
}

function mapSourceFiles(templates: Record<string, unknown>, parts: Record<string, unknown>, theme: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const key of Object.keys(templates)) result.set(`template:${theme}//${key}`, `theme/templates/${key}.html`);
  for (const key of Object.keys(parts)) result.set(`part:${theme}//${key}`, `theme/parts/${key}.html`);
  return result;
}

function updateManifest(manifest: PullManifest, changed: PullFile[]): PullManifest {
  if (changed.length === 0) return manifest;
  const replacements = new Map(changed.map(file => [file.path, file]));
  const bundleFiles = manifest.bundleFiles.map(entry => {
    const changedFile = replacements.get(entry.path);
    return changedFile ? { path: entry.path, sha256: changedFile.afterSha256, size: changedFile.afterSize } : entry;
  });
  const inventory = manifest.inventory?.map(entry => {
    const changedFile = replacements.get(`theme/${entry.path}`);
    return changedFile ? { path: entry.path, sha256: changedFile.afterSha256, size: changedFile.afterSize } : entry;
  });
  const result: PullManifest = { ...manifest, bundleFiles, ...(inventory ? { inventory } : {}), sourceIntentState: 'unreconciled' };
  const current = manifest.bundleFiles.find(file => file.path === 'site.manifest.json');
  if (current) throw new Error('site manifest must not list itself in bundleFiles');
  return result;
}

async function publishOne(preview: string, body: PullPlanBody, relative: string, isManifest: boolean): Promise<void> {
  const bundle = body.bundlePath;
  const source = relative === 'site.manifest.json' ? 'after/site.manifest.json' : path.join('after', ...relative.split('/'));
  const before = relative === 'site.manifest.json' ? 'before/site.manifest.json' : path.join('before', ...relative.split('/'));
  const target = path.join(bundle, ...relative.split('/'));
  const beforeBytes = await readStableRegularFile(path.join(preview, before), 'retained pull before-bytes are missing or changed');
  const afterBytes = await readStableRegularFile(path.join(preview, source), 'retained pull after-bytes are missing or changed');
  const beforeHash = hashBytes(beforeBytes.content);
  const expected = isManifest ? await readStableRegularFile(target, 'site manifest changed before pull publication') : beforeBytes;
  const expectedHash = isManifest ? hashBytes(expected.content) : beforeHash;
  if (isManifest) {
    if (hashBytes(beforeBytes.content) !== body.manifestBeforeSha256) throw new Error('retained pre-pull manifest bytes are missing or changed');
    if (hashBytes(expected.content) !== body.manifestBeforeSha256 || hashBytes(afterBytes.content) !== body.manifestAfterSha256
      || afterBytes.content.toString('utf8') !== body.manifestAfterContent) throw new Error('manifest bytes differ from the confirmed pull plan');
  } else {
    const file = body.files.find(entry => entry.path === relative);
    if (!file || expectedHash !== file.beforeSha256 || hashBytes(afterBytes.content) !== file.afterSha256) throw new Error(`staged bytes differ from the confirmed pull plan: ${relative}`);
  }
  await assertSafeDirectoryParent(path.dirname(target));
  const current = await readStableRegularFile(target, `pull target is missing, unsafe, or changed: ${relative}`);
  if (hashBytes(current.content) !== expectedHash || !current.content.equals(expected.content)) throw new Error(`pull target changed before atomic replacement: ${relative}`);
  const plannedFile = body.files.find(entry => entry.path === relative);
  if (hashBytes(afterBytes.content) !== (isManifest ? body.manifestAfterSha256 : plannedFile?.afterSha256)) throw new Error(`staged output hash differs from its plan: ${relative}`);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.block-runner-pull-${randomUUID()}.tmp`);
  await stagePublicationBytes(temporary, afterBytes.content, (await lstat(target)).mode & 0o7777);
  try {
    const rechecked = await readStableRegularFile(target, `pull target changed before atomic replacement: ${relative}`);
    if (hashBytes(rechecked.content) !== expectedHash || !rechecked.content.equals(expected.content)) throw new Error(`pull target changed before atomic replacement: ${relative}`);
    await publishStagedFile(temporary, target, true);
    const installed = await readStableRegularFile(target, `published pull target cannot be verified: ${relative}`);
    if (!installed.content.equals(afterBytes.content)) throw new Error(`published pull target failed exact byte readback: ${relative}`);
  } catch (error) {
    try { await unlink(temporary); } catch { /* retain the publication journal; temp cleanup is best effort */ }
    throw error;
  }
}

async function classifyTarget(bundle: string, preview: string, relative: string): Promise<'before' | 'after' | 'unknown'> {
  try {
    const target = await readStableRegularFile(path.join(bundle, ...relative.split('/')), 'target cannot be inspected after interrupted publication');
    const staged = await readStableRegularFile(path.join(preview, relative === 'site.manifest.json' ? 'after/site.manifest.json' : path.join('after', ...relative.split('/'))), 'staged output cannot be inspected after interrupted publication');
    const before = await readStableRegularFile(path.join(preview, relative === 'site.manifest.json' ? 'before/site.manifest.json' : path.join('before', ...relative.split('/'))), 'before-bytes cannot be inspected after interrupted publication');
    if (target.content.equals(staged.content)) return 'after';
    if (target.content.equals(before.content)) return 'before';
  } catch { return 'unknown'; }
  return 'unknown';
}

async function verifyPreviewStage(preview: string, body: PullPlanBody): Promise<void> {
  const beforeManifest = await readStableRegularFile(path.join(preview, 'before/site.manifest.json'), 'retained pre-pull manifest bytes are missing or changed');
  const afterManifest = await readStableRegularFile(path.join(preview, 'after/site.manifest.json'), 'staged post-pull manifest bytes are missing or changed');
  if (hashBytes(beforeManifest.content) !== body.manifestBeforeSha256 || hashBytes(afterManifest.content) !== body.manifestAfterSha256
    || afterManifest.content.toString('utf8') !== body.manifestAfterContent) throw new Error('staged manifest bytes differ from the confirmed pull plan');
  for (const file of body.files) {
    const before = await readStableRegularFile(path.join(preview, 'before', ...file.path.split('/')), 'retained pull before-bytes are missing or changed');
    const after = await readStableRegularFile(path.join(preview, 'after', ...file.path.split('/')), 'staged pull after-bytes are missing or changed');
    if (hashBytes(before.content) !== file.beforeSha256 || before.content.byteLength !== file.beforeSize
      || hashBytes(after.content) !== file.afterSha256 || after.content.byteLength !== file.afterSize) throw new Error(`staged source bytes differ from the confirmed pull plan: ${file.path}`);
  }
}

function parseManifest(bytes: Buffer): PullManifest {
  let value: PullManifest;
  try { value = JSON.parse(bytes.toString('utf8')) as PullManifest; } catch { throw new Error('retained site manifest is invalid JSON'); }
  if (!value || value.formatVersion !== 1 || !value.siteId || !value.sourceIdentity || !value.artifactIdentity
    || !['site', 'theme'].includes(value.artifactType) || !Array.isArray(value.bundleFiles)
    || !Array.isArray(value.inventory)
    || (value.sourceIntentState !== undefined && value.sourceIntentState !== 'unreconciled')) throw new Error('retained site manifest has an invalid pull identity');
  const bundleTheme = new Map(value.bundleFiles.filter(entry => entry.path.startsWith('theme/')).map(entry => [entry.path.slice(6), entry]));
  const inventoryPaths = new Set<string>();
  for (const entry of value.inventory) {
    assertRelativePath(entry.path);
    if (inventoryPaths.has(entry.path)) throw new Error('retained theme inventory contains duplicate paths');
    inventoryPaths.add(entry.path);
    const bundled = bundleTheme.get(entry.path);
    if (!bundled || bundled.sha256 !== entry.sha256 || bundled.size !== entry.size) throw new Error(`retained theme inventory differs from bundle bytes for ${entry.path}`);
  }
  if (bundleTheme.size !== inventoryPaths.size) throw new Error('retained theme bundle files and inventory paths differ');
  return value;
}

async function readBundleFile(bundle: string, relative: string): Promise<Buffer> {
  assertRelativePath(relative);
  const file = path.join(bundle, ...relative.split('/'));
  await assertSafePathChain(file);
  const stable = await readStableRegularFile(file, `bundle file is missing, unsafe, or changed: ${relative}`);
  return stable.content;
}

async function writePrivateFile(file: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function createInitialJournal(file: string, journal: PullJournal): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

async function assertSafeDirectoryParent(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe pull directory path: ${current}`);
  }
}

async function assertSafePathChain(file: string): Promise<void> {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < components.length - 1 && !info.isDirectory())) throw new Error(`unsafe pull source path: ${current}`);
  }
}

function assertRelativePath(relative: string): void {
  if (!relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('unsafe pull file path');
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
