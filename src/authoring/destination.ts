import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readlink, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedRegisteredBlock } from './generate.js';
import { hashAuthoringPlan, type AuthoringPlan, type AuthoringFileOperation } from './schema.js';

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
  content: string;
  replace: boolean;
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
 * exact lexical destination and filesystem snapshot shown by `author preview`.
 */
export function hashAuthoringConfirmation(
  plan: AuthoringPlan,
  destination: AuthoringDestinationApproval,
): string {
  return hashBuffer(Buffer.from(stableJson({
    planHash: hashAuthoringPlan(plan),
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
): Promise<{ directory: string; fingerprint: string; written: string[] }> {
  const allFiles = plannedFiles(output);
  const files = allFiles.filter((file): file is MaterializedFile => typeof file.content === 'string');
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

  const staged: Array<{ file: MaterializedFile; target: string; temporary: string }> = [];
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
      staged.push({ file, target, temporary });
    }

    // Staging changes directory mtimes, so the fingerprint deliberately tracks directory
    // identity but not those mutable timestamps. Re-inspect paths and target identities here.
    const immediatelyBeforePublish = await inspectAuthoringDestination(preflight.directory, output);
    if (immediatelyBeforePublish.fingerprint !== preflight.fingerprint) {
      throw new Error('authoring destination changed before files could be written');
    }
    assertCollisions(immediatelyBeforePublish, files, preflight.directory);

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
        await rename(item.temporary, item.target);
      } else {
        // `link` has O_EXCL-like publication semantics: it cannot replace a file that appeared
        // after preflight. It also keeps publication atomic because temp and target share a dir.
        await link(item.temporary, item.target);
        await unlink(item.temporary);
      }
    }

    const after = await inspectAuthoringDestination(preflight.directory, output);
    return { directory: after.directory, fingerprint: after.fingerprint, written: files.map((file) => file.path) };
  } finally {
    await Promise.all(
      staged.map(async ({ temporary }) => {
        try {
          await unlink(temporary);
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }
      }),
    );
  }
}

/** Write a sealed registered-block package; callers never pass a mutable plan to this boundary. */
export function writeGeneratedRegisteredBlock(
  outputDirectory: string,
  generated: GeneratedRegisteredBlock,
  approval?: AuthoringDestinationApproval,
): Promise<{ directory: string; fingerprint: string; written: string[] }> {
  return writeAuthoringOutput(outputDirectory, generated, approval);
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

async function lstatRegular(file: string, plannedPath: string): Promise<FileIdentity> {
  const stats = await lstat(file);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`planned destination is no longer a regular file: ${plannedPath}`);
  }
  return identityFor(file, stats, true);
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
