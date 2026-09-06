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
    try {
      const stable = await readStableRegularFile(target(entry), `published target changed: ${target(entry)}`);
      if (publicationHash(stable.content) !== expectedHash(entry)) throw conflict(entry);
      observed.set(entry, stable.identity);
      await onValidated?.(entry);
    } catch (error) { throw error instanceof Error && error.message.startsWith('published target changed:') ? conflict(entry) : error; }
  }
  for (const entry of entries) {
    try {
      if (!sameFileIdentity(observed.get(entry)!, await regularFileIdentity(target(entry), `published target changed: ${target(entry)}`))) throw conflict(entry);
    } catch (error) { throw error instanceof Error && error.message.startsWith('published target changed:') ? conflict(entry) : error; }
  }
}

export function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
