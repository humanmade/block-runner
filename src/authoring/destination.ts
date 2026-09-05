import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readlink, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { REGISTERED_BLOCK_TEMPLATE_VERSION, REGISTERED_BLOCK_STYLE_EMITTER_VERSION, WORDPRESS_BLOCK_SCHEMA_VERSION,
  type GeneratedRegisteredBlock } from './generate.js';
import { hashAuthoringPlan, type AuthoringPlan, type AuthoringFileOperation } from './schema.js';
import { classifyRegisteredBlockRegeneration } from './regeneration.js';

/** A read-only representation of the filesystem state relevant to a plan. */
export interface DestinationInspection {
  directory: string;
  fingerprint: string;
  entries: ReadonlyArray<DestinationEntry>;
}

/** The destination facts a preview binds into its write confirmation. */
export interface AuthoringDestinationApproval {
  directory: string;
  fingerprint: string;
}

export interface DestinationEntry {
  path: string;
  kind: 'directory' | 'file' | 'missing';
  identity?: FileIdentity;
}

interface FileIdentity {
  dev: string;
  ino: string;
  mode: number;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256?: string;
}

interface MaterializedFile {
  path: string;
  content: string | Buffer;
  replace: boolean;
}

/** One target in the durable, bounded record retained after interrupted publication. */
export interface PublicationRecoveryEntry {
  /** Package-relative path, never a temporary staging path. */
  path: string;
  /** Hash of the approved file before replacement, when this was a replacement. */
  beforeHash?: string;
  /** Hash of the fully staged bytes that were approved for this target. */
  afterHash: string;
  /** Exact approved bytes from before a replacement, retained for recovery/audit. */
  beforeContent?: Buffer;
}

/**
 * A publication never spans filesystems atomically. This record identifies exactly which target
 * publications happened, which staged targets remain, and the original bytes for replacements.
 */
export interface PublicationRecovery {
  directory: string;
  completed: ReadonlyArray<PublicationRecoveryEntry>;
  pending: ReadonlyArray<PublicationRecoveryEntry>;
  replacements: ReadonlyArray<PublicationRecoveryEntry>;
  /** The private, same-directory journal retained for a process-independent retry. */
  recordPath?: string;
}

export interface AuthoringPublicationOptions {
  /** Test-only deterministic fault injection, counted immediately after target publication. */
  failAfterPublishStep?: number;
  /** Invoked after each target has been published and durably recorded as completed. */
  onPublished?: (entry: PublicationRecoveryEntry, recovery: PublicationRecovery) => void | Promise<void>;
  /**
   * Test-only hook after a target has been stably observed by final validation. Validation
   * observes every target once, then observes the whole set again before returning success.
   */
  onFinalValidationTarget?: (entry: PublicationRecoveryEntry, validated: ReadonlyArray<PublicationRecoveryEntry>) => void | Promise<void>;
}

/** A write error with the exact recovery inventory. It is never a successful write receipt. */
export class PublicationInterruptedError extends Error {
  readonly recovery: PublicationRecovery;

  constructor(message: string, recovery: PublicationRecovery, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PublicationInterruptedError';
    this.recovery = recovery;
  }
}

interface PublicationRuntimeEntry {
  file: MaterializedFile;
  target: string;
  temporary: string;
  afterHash: string;
  beforeContent?: Buffer;
  beforeHash?: string;
  beforeIdentity?: FileIdentity;
  published: boolean;
}

interface PublicationRuntime {
  directory: string;
  recordPath: string;
  entries: PublicationRuntimeEntry[];
  publishSteps: number;
}

interface StoredPublicationRecord {
  version: 1;
  directory: string;
  entries: Array<{
    path: string;
    target: string;
    temporary: string;
    replace: boolean;
    beforeHash?: string;
    beforeIdentity?: FileIdentity;
    beforeContent?: string;
    afterHash: string;
    published: boolean;
  }>;
}

const recoveryRuntime = new WeakMap<PublicationRecovery, PublicationRuntime>();

/** A completed target no longer has the bytes that this publication recorded. */
class PublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationConflictError';
  }
}

export interface AuthoringOutputFile {
  path: string;
  content?: unknown;
  operation?: AuthoringFileOperation;
}

export interface AuthoringOutputPlan {
  files: ReadonlyArray<AuthoringOutputFile>;
}

interface PlannedOutput {
  path: string;
  content?: unknown;
  replace: boolean;
}

/**
 * Snapshot a destination without making it exist. Apart from a small fixed set of OS-owned root
 * aliases, every lexical component from the filesystem root to the requested path is lstat'ed,
 * so no user-controlled link is ever resolved before it can be rejected.
 */
export async function inspectAuthoringDestination(
  outputDirectory: string,
  output: AuthoringOutputPlan,
): Promise<DestinationInspection> {
  const directory = await canonicalizeTrustedSystemAlias(outputDirectory);
  const files = plannedFiles(output);
  const entries = new Map<string, DestinationEntry>();

  await inspectDirectoryPath(directory, entries);
  for (const file of files) {
    await inspectPlannedPath(directory, file.path, entries);
  }

  const ordered = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  return {
    directory,
    fingerprint: fingerprint({ directory, entries: ordered }),
    entries: ordered,
  };
}

/**
 * Produce the value accepted by `author write --confirm`. It binds the canonical plan to the
 * compiler contract, exact lexical destination, and filesystem snapshot shown by `author preview`.
 */
export function hashAuthoringConfirmation(
  plan: AuthoringPlan,
  destination: AuthoringDestinationApproval,
): string {
  return hashBuffer(Buffer.from(stableJson({
    planHash: hashAuthoringPlan(plan),
    compiler: { template: REGISTERED_BLOCK_TEMPLATE_VERSION, styles: REGISTERED_BLOCK_STYLE_EMITTER_VERSION,
      wordpressSchema: WORDPRESS_BLOCK_SCHEMA_VERSION },
    destination: {
      directory: path.resolve(destination.directory),
      fingerprint: destination.fingerprint,
    },
  }), 'utf8'));
}

/**
 * Publish immutable, generated source through an exclusive hard-link. Replacements require the
 * separate, hash-bound operation carried by the sealed output package.
 */
export async function writeAuthoringOutput(
  outputDirectory: string,
  output: AuthoringOutputPlan,
  approval?: AuthoringDestinationApproval,
  options: AuthoringPublicationOptions = {},
): Promise<{ directory: string; fingerprint: string; written: string[] }> {
  const allFiles = plannedFiles(output);
  const files = allFiles.filter((file): file is MaterializedFile => typeof file.content === 'string' || Buffer.isBuffer(file.content));
  const before = await inspectAuthoringDestination(outputDirectory, output);
  if (approval && (before.directory !== path.resolve(approval.directory) || before.fingerprint !== approval.fingerprint)) {
    throw new Error('authoring destination no longer matches the reviewed preview; no files written');
  }
  assertCollisions(before, allFiles, before.directory);

  // A no-source plan is intentional for this release. It must still have passed the same
  // symlink/path/collision inspection, but does not create an empty destination directory.
  if (files.length === 0) {
    return { directory: before.directory, fingerprint: before.fingerprint, written: [] };
  }

  await ensureDirectory(before.directory);
  for (const file of files) {
    await ensureDirectory(path.dirname(toOutputPath(before.directory, file.path)));
  }

  // Re-run every safety decision after creating the directory tree and immediately before any
  // content reaches disk. This catches a changed target, link insertion, or collision.
  const preflight = await inspectAuthoringDestination(before.directory, output);
  assertCollisions(preflight, files, before.directory);

  const staged: PublicationRuntimeEntry[] = [];
  let runtime: PublicationRuntime | undefined;
  let publicationAttempted = false;
  let publicationComplete = false;
  try {
    for (const file of files) {
      const target = toOutputPath(preflight.directory, file.path);
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.block-runner-${randomBytes(12).toString('hex')}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(file.content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      staged.push({ file, target, temporary, afterHash: sha256(Buffer.from(file.content)), published: false });
    }

    // Staging changes directory mtimes, so the fingerprint deliberately tracks directory
    // identity but not those mutable timestamps. Re-inspect paths and target identities here.
    const immediatelyBeforePublish = await inspectAuthoringDestination(preflight.directory, output);
    if (immediatelyBeforePublish.fingerprint !== preflight.fingerprint) {
      throw new Error('authoring destination changed before files could be written');
    }
    assertCollisions(immediatelyBeforePublish, files, preflight.directory);

    // Capture approved replacement bytes before the first target publication. They are held in
    // the bounded recovery journal as well as in an interrupted error, so a caller can inspect
    // or retry without pretending this multi-file operation was atomic.
    for (const item of staged) {
      const existing = entryFor(immediatelyBeforePublish, item.target);
      if (existing?.kind === 'file') {
        if (!item.file.replace) {
          throw new Error(`planned file already exists: ${item.file.path}; add an explicit replace decision to the plan`);
        }
        // Rename is atomic within this verified directory. The final lstat is intentionally
        // adjacent to publication so a different file is never silently approved for replacement.
        const now = await lstatRegular(item.target, item.file.path);
        if (!sameIdentity(now, existing.identity)) {
          throw new Error(`planned file changed before replacement: ${item.file.path}`);
        }
        const beforeContent = await readFile(item.target);
        const afterRead = await lstatRegular(item.target, item.file.path);
        if (!sameIdentity(afterRead, existing.identity) || hashBuffer(beforeContent) !== existing.identity?.sha256) {
          throw new Error(`planned file changed before replacement: ${item.file.path}`);
        }
        item.beforeContent = Buffer.from(beforeContent);
        item.beforeHash = sha256(beforeContent);
        item.beforeIdentity = afterRead;
      }
    }

    runtime = {
      directory: preflight.directory,
      recordPath: publicationRecordPath(preflight.directory),
      entries: staged,
      publishSteps: 0,
    };
    await writePublicationRecord(runtime);

    for (const item of runtime.entries) {
      publicationAttempted = true;
      await publishStagedTarget(runtime, item);
      item.published = true;
      await writePublicationRecord(runtime);
      await afterPublicationStep(runtime, item, options);
    }

    const after = await inspectAuthoringDestination(preflight.directory, output);
    await verifyPublishedTargets(runtime, options);
    publicationComplete = true;
    return { directory: after.directory, fingerprint: after.fingerprint, written: files.map((file) => file.path) };
  } catch (error) {
    if (runtime && publicationAttempted) {
      await reconcilePublishedTargets(runtime);
      // The in-memory inventory remains authoritative if this final journal update itself hits
      // an I/O error; never discard the original publication failure for cleanup trouble.
      try {
        await writePublicationRecord(runtime);
      } catch {
        // The journal was written before target publication. A failed update can only make it
        // conservatively stale; the structured error still identifies the exact current state.
      }
      if (error instanceof PublicationConflictError) throw error;
      const recovery = publicationRecovery(runtime);
      recoveryRuntime.set(recovery, runtime);
      throw new PublicationInterruptedError('authoring publication was interrupted; use its recovery record before retrying', recovery, { cause: error });
    }
    throw error;
  } finally {
    if (publicationComplete) {
      await cleanupPublicationRuntime(runtime);
    } else if (!publicationAttempted) {
      // A failure while staging or recording the pre-publication inventory has not made a
      // destination write. Remove both kinds of private bookkeeping rather than leaving a
      // journal that could be mistaken for an interrupted publication.
      if (runtime) await cleanupPublicationRuntime(runtime);
      else await cleanupStaging(staged);
    }
  }
}

/** Verify generated bytes against their manifest before publishing the package. */
export async function writeGeneratedRegisteredBlock(
  outputDirectory: string,
  generated: GeneratedRegisteredBlock,
  approval?: AuthoringDestinationApproval,
  options: AuthoringPublicationOptions = {},
): Promise<{ directory: string; fingerprint: string; written: string[] }> {
  // Buffers remain mutable after compilation. Snapshot every byte before the
  // first await so a caller cannot change an asset during destination checks.
  const generatedSnapshot: GeneratedRegisteredBlock = {
    ...generated,
    files: generated.files.map((file) => ({ ...file, content: Buffer.from(file.content).toString('utf8') })),
    assets: generated.assets.map((file) => ({ ...file, content: Buffer.from(file.content) })),
    manifest: { ...generated.manifest, files: generated.manifest.files.map((entry) => ({ ...entry })) },
    template: structuredClone(generated.template),
  };
  const files = [...generatedSnapshot.files, ...generatedSnapshot.assets].map((file) => ({
    ...file, content: Buffer.from(file.content),
  }));
  if (generatedSnapshot.manifest.files.length !== files.length) throw new Error('Generated manifest does not cover every output file.');
  for (const file of files) {
    const entries = generatedSnapshot.manifest.files.filter((entry) => entry.path === file.path);
    const entry = entries[0];
    if (entries.length !== 1 || !entry || entry.operation !== file.operation
      || entry.contentHash !== file.hash || hashBuffer(file.content) !== file.hash
      || entry.sourcePlanHash !== generatedSnapshot.sourcePlanHash || entry.templateVersion !== generatedSnapshot.templateVersion) {
      throw new Error(`Generated bytes or manifest changed before writing: ${file.path}`);
    }
  }
  const inspection = await inspectAuthoringDestination(outputDirectory, { files });
  const regeneration = await classifyRegisteredBlockRegeneration(inspection, generatedSnapshot);
  // Exact compiler output is a no-op even when its original manifest carries create operations:
  // it neither replaces nor claims an existing user file.
  if (regeneration.kind === 'unchanged') {
    return { directory: inspection.directory, fingerprint: inspection.fingerprint, written: [] };
  }
  // A changed package must establish ownership before its regeneration impact is acted on. A
  // user-owned create collision is never evidence of an earlier compiler package.
  assertCollisions(inspection, files.map((file) => ({ path: file.path, replace: file.operation === 'replace' })), inspection.directory);
  if (!regeneration.writeAllowed) {
    throw new Error('saved-markup or structure changed; no files written. ' + regeneration.nextStep);
  }
  return writeAuthoringOutput(outputDirectory, { files }, approval, options);
}

/**
 * Continue an interrupted authoring publication. The pending target is published only if it is
 * still missing (for creates) or still has the reviewed pre-replacement hash (for replacements).
 * A target changed by another process is refused, and unrelated paths are never touched.
 */
export async function retryAuthoringPublication(
  recovery: PublicationRecovery,
  options: AuthoringPublicationOptions = {},
): Promise<{ directory: string; fingerprint: string; written: string[] }> {
  const runtime = recoveryRuntime.get(recovery) ?? await readPublicationRuntime(recovery);
  return resumeAuthoringPublication(runtime, options);
}

/** Alias for callers that present retry as an explicit recovery action. */
export async function recoverAuthoringPublication(
  recovery: PublicationRecovery,
  options: AuthoringPublicationOptions = {},
): Promise<{ directory: string; fingerprint: string; written: string[] }> {
  return retryAuthoringPublication(recovery, options);
}

function publicationRecordPath(directory: string): string {
  return path.join(directory, `.block-runner-publication-${randomBytes(12).toString('hex')}.json`);
}

function publicationEntry(entry: PublicationRuntimeEntry): PublicationRecoveryEntry {
  return {
    path: entry.file.path,
    ...(entry.beforeHash ? { beforeHash: entry.beforeHash } : {}),
    afterHash: entry.afterHash,
    ...(entry.beforeContent ? { beforeContent: Buffer.from(entry.beforeContent) } : {}),
  };
}

function publicationRecovery(runtime: PublicationRuntime): PublicationRecovery {
  const recovery: PublicationRecovery = {
    directory: runtime.directory,
    completed: runtime.entries.filter((entry) => entry.published).map(publicationEntry),
    pending: runtime.entries.filter((entry) => !entry.published).map(publicationEntry),
    replacements: runtime.entries.filter((entry) => entry.published && entry.beforeHash).map(publicationEntry),
    recordPath: runtime.recordPath,
  };
  return recovery;
}

function storedPublicationRecord(runtime: PublicationRuntime): StoredPublicationRecord {
  return {
    version: 1,
    directory: runtime.directory,
    entries: runtime.entries.map((entry) => ({
      path: entry.file.path,
      target: entry.target,
      temporary: entry.temporary,
      replace: entry.file.replace,
      ...(entry.beforeHash ? { beforeHash: entry.beforeHash } : {}),
      ...(entry.beforeIdentity ? { beforeIdentity: entry.beforeIdentity } : {}),
      ...(entry.beforeContent ? { beforeContent: entry.beforeContent.toString('base64') } : {}),
      afterHash: entry.afterHash,
      published: entry.published,
    })),
  };
}

async function writePublicationRecord(runtime: PublicationRuntime): Promise<void> {
  const parent = path.dirname(runtime.recordPath);
  if (parent !== runtime.directory || !isPublicationRecordPath(runtime.recordPath)) {
    throw new Error('unsafe authoring publication recovery record path');
  }
  const temporary = path.join(parent, `.${path.basename(runtime.recordPath)}-${randomBytes(12).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(storedPublicationRecord(runtime))}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const existing = await lstatMaybe(runtime.recordPath);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error('authoring publication recovery record changed unexpectedly');
    }
    // This is only our randomized journal. Target publication itself never uses rename for a
    // create, and every replacement is still checked immediately before its rename.
    await rename(temporary, runtime.recordPath);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

async function publishStagedTarget(runtime: PublicationRuntime, entry: PublicationRuntimeEntry): Promise<void> {
  // Recheck the lexical destination path immediately before every individual publication. This
  // deliberately repeats the symlink and path traversal boundary after staging, when an outside
  // process has had the greatest opportunity to change the tree.
  await inspectAuthoringDestination(runtime.directory, { files: runtime.entries.map(({ file }) => file) });
  if (entry.beforeHash) {
    await assertReplacementUnchanged(entry);
    await rename(entry.temporary, entry.target);
    return;
  }
  if (await lstatMaybe(entry.target)) {
    throw new Error(`planned create file appeared before publication: ${entry.file.path}`);
  }
  // `link` has O_EXCL-like publication semantics: it cannot replace a file that appeared after
  // preflight. Temp and target share a directory, so each individual create is atomic.
  await link(entry.temporary, entry.target);
  await unlink(entry.temporary);
}

async function assertReplacementUnchanged(entry: PublicationRuntimeEntry): Promise<void> {
  if (!entry.beforeHash || !entry.beforeIdentity) {
    throw new Error(`authoring recovery record has no approved replacement identity: ${entry.file.path}`);
  }
  const beforeRead = await lstatRegular(entry.target, entry.file.path);
  if (!sameIdentity(beforeRead, entry.beforeIdentity)) {
    throw new Error(`planned file changed before replacement: ${entry.file.path}`);
  }
  const current = await readFile(entry.target);
  const afterRead = await lstatRegular(entry.target, entry.file.path);
  if (!sameIdentity(afterRead, entry.beforeIdentity) || sha256(current) !== entry.beforeHash) {
    throw new Error(`planned file changed before replacement: ${entry.file.path}`);
  }
}

async function afterPublicationStep(
  runtime: PublicationRuntime,
  entry: PublicationRuntimeEntry,
  options: AuthoringPublicationOptions,
): Promise<void> {
  runtime.publishSteps += 1;
  const recovery = publicationRecovery(runtime);
  if (options.failAfterPublishStep === runtime.publishSteps) {
    throw new Error(`injected authoring publication failure after ${entry.file.path}`);
  }
  await options.onPublished?.(publicationEntry(entry), recovery);
}

async function reconcilePublishedTargets(runtime: PublicationRuntime): Promise<void> {
  for (const entry of runtime.entries) {
    entry.published = false;
    try {
      const current = await readRegularFile(entry.target, entry.file.path);
      if (sha256(current) === entry.afterHash) {
        entry.published = true;
      }
    } catch {
      // Preserve the original publication error. A malformed or linked target cannot count as a
      // completed publication and remains pending in the recovery inventory.
    }
  }
}

async function cleanupStaging(entries: ReadonlyArray<PublicationRuntimeEntry>): Promise<void> {
  // Validate every path before unlinking any of them. A persisted recovery record can describe
  // already-published entries whose staging files no longer exist, but it must never turn them
  // into arbitrary cleanup paths.
  entries.forEach(assertStagingPath);
  await Promise.all(entries.map(async ({ temporary }) => {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }));
}

async function cleanupPublicationRuntime(runtime: PublicationRuntime | undefined): Promise<void> {
  if (!runtime) return;
  await cleanupStaging(runtime.entries);
  try {
    await unlink(runtime.recordPath);
  } catch (error) {
    // A complete record is harmless and is safer than treating an otherwise complete artifact as
    // failed merely because its private cleanup file could not be removed.
    if (!isNotFound(error)) return;
  }
}

async function resumeAuthoringPublication(
  runtime: PublicationRuntime,
  options: AuthoringPublicationOptions,
): Promise<{ directory: string; fingerprint: string; written: string[] }> {
  let publicationAttempted = false;
  let publicationComplete = false;
  try {
    await validateRecoveryRuntime(runtime);
    await writePublicationRecord(runtime);
    for (const entry of runtime.entries) {
      if (entry.published) continue;
      publicationAttempted = true;
      await publishStagedTarget(runtime, entry);
      entry.published = true;
      await writePublicationRecord(runtime);
      await afterPublicationStep(runtime, entry, options);
    }
    const after = await inspectAuthoringDestination(runtime.directory, { files: runtime.entries.map(({ file }) => file) });
    await verifyPublishedTargets(runtime, options);
    publicationComplete = true;
    return { directory: after.directory, fingerprint: after.fingerprint, written: runtime.entries.map(({ file }) => file.path) };
  } catch (error) {
    if (publicationAttempted) {
      await reconcilePublishedTargets(runtime);
      try {
        await writePublicationRecord(runtime);
      } catch {
        // The record that existed before retry remains a conservative recovery point.
      }
      if (error instanceof PublicationConflictError) throw error;
      const recovery = publicationRecovery(runtime);
      recoveryRuntime.set(recovery, runtime);
      throw new PublicationInterruptedError('authoring publication retry was interrupted; use its recovery record before retrying', recovery, { cause: error });
    }
    throw error;
  } finally {
    if (publicationComplete) {
      await cleanupPublicationRuntime(runtime);
    }
  }
}

async function validateRecoveryRuntime(runtime: PublicationRuntime): Promise<void> {
  const inspection = await inspectAuthoringDestination(runtime.directory, { files: runtime.entries.map(({ file }) => file) });
  if (inspection.directory !== runtime.directory) {
    throw new Error('authoring publication recovery directory changed unexpectedly');
  }
  for (const entry of runtime.entries) {
    const current = await readRegularFileMaybe(entry.target, entry.file.path);
    if (entry.published) {
      if (!current || sha256(current) !== entry.afterHash) {
        throw new Error(`published file changed after interrupted publication: ${entry.file.path}`);
      }
      continue;
    }
    if (current && sha256(current) === entry.afterHash) {
      // An error from the kernel after publication is ambiguous. Treat an exact staged hash as
      // completed rather than overwrite it on retry.
      entry.published = true;
      continue;
    }
    if (entry.beforeHash) {
      if (!current || sha256(current) !== entry.beforeHash || !entry.beforeIdentity) {
        throw new Error(`planned file changed after interrupted publication: ${entry.file.path}`);
      }
      await assertReplacementUnchanged(entry);
    } else if (current) {
      throw new Error(`planned create file appeared after interrupted publication: ${entry.file.path}`);
    }
    await assertStagedFile(entry);
  }
}

async function assertStagedFile(entry: PublicationRuntimeEntry): Promise<void> {
  assertStagingPath(entry);
  const staged = await readRegularFile(entry.temporary, entry.file.path);
  if (sha256(staged) !== entry.afterHash) {
    throw new Error(`staged authoring bytes changed after interrupted publication: ${entry.file.path}`);
  }
}

function assertStagingPath(entry: Pick<PublicationRuntimeEntry, 'file' | 'target' | 'temporary'>): void {
  const temporary = path.resolve(entry.temporary);
  const expectedDirectory = path.dirname(entry.target);
  const escapedTarget = path.basename(entry.target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (temporary !== entry.temporary || path.dirname(temporary) !== expectedDirectory
    || !new RegExp(`^\\.${escapedTarget}\\.block-runner-[a-f0-9]{24}\\.tmp$`).test(path.basename(temporary))) {
    throw new Error(`unsafe authoring recovery staging path: ${entry.file.path}`);
  }
}

async function verifyPublishedTargets(runtime: PublicationRuntime, options: AuthoringPublicationOptions): Promise<void> {
  const validated: PublicationRecoveryEntry[] = [];
  const observed = new Map<string, FileIdentity>();
  for (const entry of runtime.entries) {
    observed.set(entry.target, await assertPublishedTarget(entry));
    validated.push(publicationEntry(entry));
    await options.onFinalValidationTarget?.(publicationEntry(entry), validated);
  }
  // Recheck exact identities after every target's content has been read. This catches an
  // earlier target replaced while a later target was being validated. The guarantee ends at
  // this final observation and makes no perpetual or cross-filesystem atomicity claim.
  for (const entry of runtime.entries) {
    if (!sameIdentity(observed.get(entry.target)!, await lstatRegular(entry.target, entry.file.path, false))) {
      throw new PublicationConflictError(`authoring publication conflict: completed target changed: ${entry.file.path}`);
    }
  }
}

async function assertPublishedTarget(entry: PublicationRuntimeEntry): Promise<FileIdentity> {
  try {
    const { content, identity } = await readRegularFileWithIdentity(entry.target, entry.file.path);
    if (sha256(content) !== entry.afterHash) {
      throw new PublicationConflictError(`authoring publication conflict: completed target changed: ${entry.file.path}`);
    }
    return identity;
  } catch (error) {
    if (error instanceof PublicationConflictError) throw error;
    throw new PublicationConflictError(`authoring publication conflict: completed target changed: ${entry.file.path}`);
  }
}

async function readPublicationRuntime(recovery: PublicationRecovery): Promise<PublicationRuntime> {
  if (!recovery.recordPath || typeof recovery.directory !== 'string') {
    throw new Error('authoring publication recovery record is unavailable');
  }
  const directory = await canonicalizeTrustedSystemAlias(recovery.directory);
  const recordPath = path.resolve(recovery.recordPath);
  if (path.dirname(recordPath) !== directory || !isPublicationRecordPath(recordPath)) {
    throw new Error('unsafe authoring publication recovery record path');
  }
  const serialized = await readRegularFile(recordPath, path.basename(recordPath));
  let record: unknown;
  try {
    record = JSON.parse(serialized.toString('utf8'));
  } catch {
    throw new Error('authoring publication recovery record is invalid');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('authoring publication recovery record is invalid');
  }
  const value = record as Partial<StoredPublicationRecord>;
  if (value.version !== 1 || value.directory !== directory || !Array.isArray(value.entries)) {
    throw new Error('authoring publication recovery record is invalid');
  }
  const paths = new Set<string>();
  const entries: PublicationRuntimeEntry[] = value.entries.map((stored) => {
    if (!stored || typeof stored !== 'object' || typeof stored.path !== 'string'
      || typeof stored.target !== 'string' || typeof stored.temporary !== 'string'
      || typeof stored.replace !== 'boolean' || typeof stored.afterHash !== 'string'
      || typeof stored.published !== 'boolean') {
      throw new Error('authoring publication recovery record is invalid');
    }
    const relative = assertSafePlannedPath(stored.path);
    if (paths.has(relative)) throw new Error('authoring publication recovery record has duplicate path');
    paths.add(relative);
    const target = toOutputPath(directory, relative);
    if (target !== stored.target) throw new Error('authoring publication recovery record target is invalid');
    let beforeContent: Buffer | undefined;
    if (stored.beforeContent !== undefined) {
      if (typeof stored.beforeContent !== 'string' || !stored.beforeHash) {
        throw new Error('authoring publication recovery record previous bytes are invalid');
      }
      beforeContent = Buffer.from(stored.beforeContent, 'base64');
      if (sha256(beforeContent) !== stored.beforeHash) {
        throw new Error('authoring publication recovery record previous bytes are invalid');
      }
    }
    if (stored.beforeIdentity !== undefined && !isFileIdentity(stored.beforeIdentity)) {
      throw new Error('authoring publication recovery record replacement identity is invalid');
    }
    if (stored.beforeHash && (!beforeContent || !stored.beforeIdentity)) {
      throw new Error('authoring publication recovery record replacement identity is invalid');
    }
    const entry: PublicationRuntimeEntry = {
      file: { path: relative, content: Buffer.alloc(0), replace: stored.replace },
      target,
      temporary: stored.temporary,
      afterHash: stored.afterHash,
      ...(beforeContent ? { beforeContent } : {}),
      ...(stored.beforeHash ? { beforeHash: stored.beforeHash } : {}),
      ...(stored.beforeIdentity ? { beforeIdentity: stored.beforeIdentity } : {}),
      published: stored.published,
    };
    // Completed entries are cleaned up during a no-op retry, so validate their staging locations
    // while loading the durable record as well as when staging bytes are needed for pending work.
    assertStagingPath(entry);
    return entry;
  });
  return { directory, recordPath, entries, publishSteps: entries.filter((entry) => entry.published).length };
}

function isPublicationRecordPath(value: string): boolean {
  return /^\.block-runner-publication-[a-f0-9]{24}\.json$/.test(path.basename(value));
}

function isFileIdentity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<FileIdentity>;
  return typeof identity.dev === 'string' && typeof identity.ino === 'string'
    && typeof identity.mode === 'number' && typeof identity.size === 'string'
    && typeof identity.mtimeNs === 'string' && typeof identity.ctimeNs === 'string'
    && (identity.sha256 === undefined || typeof identity.sha256 === 'string');
}

/** Validate again at the filesystem boundary; schema validation alone must never be trusted for writes. */
export function assertSafePlannedPath(value: string): string {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value !== path.posix.normalize(value)
  ) {
    throw new Error(`unsafe planned file path: ${JSON.stringify(value)}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe planned file path: ${JSON.stringify(value)}`);
  }
  return value;
}

async function inspectDirectoryPath(directory: string, entries: Map<string, DestinationEntry>): Promise<void> {
  const parsed = path.parse(directory);
  let current = parsed.root;
  const parts = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  await inspectDirectoryComponent(current, entries);
  for (const part of parts) {
    current = path.join(current, part);
    const entry = await inspectDirectoryComponent(current, entries);
    if (entry.kind === 'missing') {
      return;
    }
  }
}

/**
 * macOS exposes a few root-level directories through fixed compatibility links (for example
 * `/tmp` -> `/private/tmp`). They are not destinations a caller can create or redirect. Verify
 * the exact platform mapping before translating it, then inspect every remaining component
 * lexically. No caller-controlled symlink is ever followed.
 */
async function canonicalizeTrustedSystemAlias(outputDirectory: string): Promise<string> {
  const directory = path.resolve(outputDirectory);
  for (const [alias, physical] of [
    ['/tmp', '/private/tmp'],
    ['/var', '/private/var'],
    ['/etc', '/private/etc'],
  ] as const) {
    if (directory !== alias && !directory.startsWith(`${alias}${path.sep}`)) {
      continue;
    }
    const stats = await lstatMaybe(alias);
    if (!stats?.isSymbolicLink()) {
      return directory;
    }
    const target = path.resolve(path.dirname(alias), await readlink(alias));
    if (target !== physical) {
      throw new Error(`symbolic-link path is not allowed in authoring destination: ${alias}`);
    }
    return path.join(physical, path.relative(alias, directory));
  }
  return directory;
}

async function inspectPlannedPath(directory: string, relativePath: string, entries: Map<string, DestinationEntry>): Promise<void> {
  const safePath = assertSafePlannedPath(relativePath);
  let current = directory;
  const components = safePath.split('/');
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    const final = index === components.length - 1;
    const key = displayPath(current);
    if (entries.has(key)) {
      continue;
    }
    const stats = await lstatMaybe(current);
    if (!stats) {
      entries.set(key, { path: key, kind: 'missing' });
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`symbolic-link path is not allowed in authoring destination: ${key}`);
    }
    if (!final && !stats.isDirectory()) {
      throw new Error(`authoring destination parent is not a directory: ${key}`);
    }
    if (final && !stats.isFile()) {
      throw new Error(`planned destination is not a regular file: ${relativePath}`);
    }
    entries.set(key, {
      path: key,
      kind: final ? 'file' : 'directory',
      identity: await identityFor(current, stats, final),
    });
  }
}

async function inspectDirectoryComponent(directory: string, entries: Map<string, DestinationEntry>): Promise<DestinationEntry> {
  const key = displayPath(directory);
  const previous = entries.get(key);
  if (previous) {
    return previous;
  }
  const stats = await lstatMaybe(directory);
  if (!stats) {
    const missing: DestinationEntry = { path: key, kind: 'missing' };
    entries.set(key, missing);
    return missing;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`symbolic-link path is not allowed in authoring destination: ${key}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`authoring destination is not a directory: ${key}`);
  }
  const entry: DestinationEntry = { path: key, kind: 'directory', identity: await identityFor(directory, stats, false) };
  entries.set(key, entry);
  return entry;
}

async function ensureDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    const stats = await lstatMaybe(current);
    if (stats) {
      if (stats.isSymbolicLink()) {
        throw new Error(`symbolic-link path is not allowed in authoring destination: ${displayPath(current)}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`authoring destination is not a directory: ${displayPath(current)}`);
      }
      continue;
    }
    await mkdir(current);
    const created = await lstat(current);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`unsafe authoring destination directory: ${displayPath(current)}`);
    }
  }
}

function assertCollisions(inspection: DestinationInspection, files: Array<Pick<PlannedOutput, 'path' | 'replace'>>, directory: string): void {
  for (const file of files) {
    const target = toOutputPath(directory, file.path);
    const existing = entryFor(inspection, target);
    if (existing?.kind === 'file' && !file.replace) {
      throw new Error(`planned file already exists: ${file.path}; add an explicit replace decision to the plan`);
    }
  }
}

function plannedFiles(output: AuthoringOutputPlan): PlannedOutput[] {
  const maybeFiles = output.files;
  if (!Array.isArray(maybeFiles)) {
    return [];
  }
  const seen = new Set<string>();
  return maybeFiles.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('authoring plan has an invalid planned file');
    }
    const value = candidate as { path?: unknown; content?: unknown; operation?: unknown };
    if (typeof value.path !== 'string') {
      throw new Error('authoring plan has a planned file without a path');
    }
    const filePath = assertSafePlannedPath(value.path);
    if (seen.has(filePath)) {
      throw new Error(`authoring plan has duplicate planned file path: ${filePath}`);
    }
    seen.add(filePath);
    return { path: filePath, content: value.content, replace: value.operation === 'replace' };
  });
}

function toOutputPath(directory: string, relativePath: string): string {
  const safe = assertSafePlannedPath(relativePath);
  const target = path.resolve(directory, ...safe.split('/'));
  if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) {
    throw new Error(`planned file escapes output directory: ${JSON.stringify(relativePath)}`);
  }
  return target;
}

async function identityFor(file: string, stats: Awaited<ReturnType<typeof lstat>>, includeContent: boolean): Promise<FileIdentity> {
  const withNs = stats as typeof stats & { mtimeNs?: bigint; ctimeNs?: bigint };
  // Directory mtimes/ctimes change when we stage same-directory temporary files. Their stable
  // identity is what matters for escape prevention; target regular files retain full metadata
  // and bytes in the fingerprint.
  const directory = stats.isDirectory();
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: Number(stats.mode),
    size: directory ? '0' : String(stats.size),
    mtimeNs: directory ? '0' : String(withNs.mtimeNs ?? BigInt(Math.round(Number(stats.mtimeMs) * 1_000_000))),
    ctimeNs: directory ? '0' : String(withNs.ctimeNs ?? BigInt(Math.round(Number(stats.ctimeMs) * 1_000_000))),
    ...(includeContent ? { sha256: hashBuffer(await readFile(file)) } : {}),
  };
}

async function lstatRegular(file: string, plannedPath: string, includeContent = true): Promise<FileIdentity> {
  const stats = await lstat(file);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`planned destination is no longer a regular file: ${plannedPath}`);
  }
  return identityFor(file, stats, includeContent);
}

async function readRegularFile(file: string, plannedPath: string): Promise<Buffer> {
  return (await readRegularFileWithIdentity(file, plannedPath)).content;
}

async function readRegularFileWithIdentity(file: string, plannedPath: string): Promise<{ content: Buffer; identity: FileIdentity }> {
  const beforeRead = await lstatRegular(file, plannedPath, false);
  const content = await readFile(file);
  // Check again after the read so a link substituted during it is not silently accepted as a
  // recovery or replacement source. Comparing the stable identity also rejects a replacement
  // that happened while the bytes were being read.
  const afterRead = await lstatRegular(file, plannedPath, false);
  if (!sameIdentity(beforeRead, afterRead)) {
    throw new Error(`planned destination changed while reading: ${plannedPath}`);
  }
  return { content, identity: afterRead };
}

async function readRegularFileMaybe(file: string, plannedPath: string): Promise<Buffer | undefined> {
  try {
    return await readRegularFile(file, plannedPath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function lstatMaybe(file: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity | undefined): boolean {
  return Boolean(right) && JSON.stringify(left) === JSON.stringify(right);
}

function entryFor(inspection: DestinationInspection, absolutePath: string): DestinationEntry | undefined {
  return inspection.entries.find((entry) => entry.path === displayPath(absolutePath));
}

function fingerprint(value: unknown): string {
  return `sha256:${hashBuffer(Buffer.from(stableJson(value), 'utf8'))}`;
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256(value: Buffer): string {
  return `sha256:${hashBuffer(value)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function displayPath(value: string): string {
  return path.resolve(value);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
