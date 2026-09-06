/**
 * Private mechanics shared by authoring and plugin publication adapters.
 *
 * This deliberately contains filesystem safety primitives rather than a public transaction
 * abstraction: each adapter owns its plan, approval policy, journal schema and presentation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises';

export interface PublicationFileIdentity {
  dev: string;
  ino: string;
  mode: number;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256?: string;
}

export function hashBytes(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function publicationHash(value: Buffer): string {
  return `sha256:${hashBytes(value)}`;
}

export function sameFileIdentity(left: PublicationFileIdentity, right: PublicationFileIdentity | undefined): boolean {
  return Boolean(right) && JSON.stringify(left) === JSON.stringify(right);
}

export async function regularFileIdentity(file: string, error: string, includeContent = false): Promise<PublicationFileIdentity> {
  const stats = await lstat(file);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(error);
  const withNs = stats as typeof stats & { mtimeNs?: bigint; ctimeNs?: bigint };
  return {
    dev: String(stats.dev), ino: String(stats.ino), mode: Number(stats.mode), size: String(stats.size),
    mtimeNs: String(withNs.mtimeNs ?? BigInt(Math.round(Number(stats.mtimeMs) * 1_000_000))),
    ctimeNs: String(withNs.ctimeNs ?? BigInt(Math.round(Number(stats.ctimeMs) * 1_000_000))),
    ...(includeContent ? { sha256: hashBytes(await readFile(file)) } : {}),
  };
}

/** Read only a stable regular file; an identity change during the read is rejected. */
export async function readStableRegularFile(file: string, error: string): Promise<{ content: Buffer; identity: PublicationFileIdentity }> {
  const before = await regularFileIdentity(file, error);
  const content = await readFile(file);
  const after = await regularFileIdentity(file, error);
  if (!sameFileIdentity(before, after)) throw new Error(error);
  return { content, identity: after };
}

/** Stage bytes exclusively and durably before any target can be published. */
export async function stagePublicationBytes(temporary: string, bytes: Buffer, mode = 0o600): Promise<string> {
  const handle = await open(temporary, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return publicationHash(bytes);
}

/** Create is link-only (never overwrite); replacements are same-filesystem atomic renames. */
export async function publishStagedFile(temporary: string, target: string, replace: boolean): Promise<void> {
  if (replace) { await rename(temporary, target); return; }
  await link(temporary, target);
  await unlink(temporary);
}

/** The small common shape used while reconciling an interrupted publication. */
export interface PublicationLifecycleEntry {
  target: string;
  temporary: string;
  afterHash: string;
}

/**
 * Observe completion from stable target bytes.  A failed observation is deliberately not a
 * completion: the caller retains its last durable inventory and can report its own conflict.
 */
export async function reconcilePublicationCompletion<T extends PublicationLifecycleEntry>(
  entries: readonly T[],
  invalidTarget: (entry: T) => string,
): Promise<Set<T>> {
  const completed = new Set<T>();
  for (const entry of entries) {
    try {
      const { content } = await readStableRegularFile(entry.target, invalidTarget(entry));
      if (publicationHash(content) === entry.afterHash) completed.add(entry);
    } catch {
      // A target that cannot be read stably cannot safely be reconciled as complete.
    }
  }
  return completed;
}

/**
 * Share the recovery decision order without absorbing adapter policy.  Adapters still own
 * containment, symlink, approval and replacement-byte checks through the supplied callbacks.
 */
export async function validatePublicationRetry<T extends PublicationLifecycleEntry>(
  entries: readonly T[],
  wasCompleted: (entry: T) => boolean,
  isPublished: (entry: T) => Promise<boolean>,
  onPreviouslyPublishedChanged: (entry: T) => Promise<void>,
  validatePending: (entry: T) => Promise<void>,
): Promise<Set<T>> {
  const completed = new Set<T>();
  for (const entry of entries) {
    if (await isPublished(entry)) {
      completed.add(entry);
      continue;
    }
    if (wasCompleted(entry)) {
      await onPreviouslyPublishedChanged(entry);
      continue;
    }
    await validatePending(entry);
  }
  return completed;
}

/** Verify pending staged bytes with the same stable-file protection as final targets. */
export async function verifyStagedPublicationBytes<T extends PublicationLifecycleEntry>(
  entry: T,
  error: string,
): Promise<void> {
  const { content } = await readStableRegularFile(entry.temporary, error);
  if (publicationHash(content) !== entry.afterHash) throw new Error(error);
}

/** Publish in plan order, recording completion before any adapter progress callback runs. */
export async function publishPublicationEntries<T>(
  entries: readonly T[],
  completed: (entry: T) => boolean,
  publish: (entry: T) => Promise<void>,
  markCompleted: (entry: T) => void,
  persist: () => Promise<void>,
  onPublished: (entry: T) => Promise<void>,
): Promise<void> {
  for (const entry of entries) {
    if (completed(entry)) continue;
    await publish(entry);
    markCompleted(entry);
    await persist();
    await onPublished(entry);
  }
}

/** Atomically replace a private JSON journal after flushing its temporary file. */
export async function replacePublicationJournal(recordPath: string, record: unknown): Promise<void> {
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, recordPath); } finally {
    try { await unlink(temporary); } catch (error) { if (!isNotFound(error)) throw error; }
  }
}

/** Two-pass validation catches an earlier target mutation during later target validation. */
export async function verifyPublicationTargets<T>(
  entries: readonly T[],
  target: (entry: T) => string,
  expectedHash: (entry: T) => string,
  conflict: (entry: T) => Error,
  onValidated?: (entry: T) => void | Promise<void>,
): Promise<void> {
  const observed = new Map<T, PublicationFileIdentity>();
  for (const entry of entries) {
    let stable: { content: Buffer; identity: PublicationFileIdentity };
    try {
      stable = await readStableRegularFile(target(entry), `published target changed: ${target(entry)}`);
    } catch {
      // Native lstat/read failures (including ENOENT and EACCES) are final-target conflicts,
      // not interruptions. Keep callbacks below this boundary so their errors stay distinct.
      throw conflict(entry);
    }
    if (publicationHash(stable.content) !== expectedHash(entry)) throw conflict(entry);
    observed.set(entry, stable.identity);
    await onValidated?.(entry);
  }
  for (const entry of entries) {
    try {
      if (!sameFileIdentity(observed.get(entry)!, await regularFileIdentity(target(entry), `published target changed: ${target(entry)}`))) throw conflict(entry);
    } catch { throw conflict(entry); }
  }
}

export function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
