import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeTrustedSystemAlias, hashBytes } from '../publication.js';
import { calculateSiteArtifactIdentity } from './compile.js';
import { verifyPreparedSiteAssets } from './assets.js';
import type { CompiledSite, PreparedSiteSource, SiteFile, ThemeArtifact } from './types.js';

export interface SiteWriteOptions {
  /** Test seam for changing an input after staging but before the final source hash check. */
  onStaged?: () => void | Promise<void>;
}

export interface SiteWriteResult {
  directory: string;
  artifactType: 'site' | 'theme';
  files: Array<{ path: string; sha256: string; size: number }>;
}

/** A failed staged publication retains the exact sibling directory for inspection. */
export class SiteWriteError extends Error {
  readonly stagingPath: string;
  readonly reservationPath?: string;

  constructor(message: string, stagingPath: string, reservationPath?: string, options?: { cause?: unknown }) {
    super(`${message}; staged bundle retained at ${stagingPath}${reservationPath ? `; output reservation retained at ${reservationPath}` : ''}`, options);
    this.name = 'SiteWriteError';
    this.stagingPath = stagingPath;
    this.reservationPath = reservationPath;
  }
}

/** Stage the complete source and output bundle beside a new target, then publish by directory rename. */
export async function writeCompiledSite(
  outputDirectory: string,
  source: PreparedSiteSource,
  artifact: CompiledSite | ThemeArtifact,
  options: SiteWriteOptions = {},
): Promise<SiteWriteResult> {
  const artifactType = 'pendingPageBindings' in artifact ? 'theme' : 'site';
  assertArtifactSource(source, artifact);
  await verifyPreparedSiteAssets(source);

  const target = await canonicalizeTrustedSystemAlias(outputDirectory);
  const parent = path.dirname(target);
  const name = path.basename(target);
  if (!name || name === '.' || name === path.parse(target).root) throw new Error('bundle output needs a named new directory');
  await assertSafeExistingDirectory(parent);
  await assertAbsentTarget(target);

  const stagingPath = path.join(parent, `.${name}.block-runner-${randomUUID()}.tmp`);
  let staged = false;
  let reservationAttempted = false;
  let reservationCreated = false;
  let reservationIdentity: DirectoryIdentity | undefined;
  try {
    await mkdir(stagingPath, { mode: 0o700 });
    await chmod(stagingPath, 0o700);
    staged = true;
    const payload = buildBundleFiles(source, artifact);
    await writeStagedFiles(stagingPath, payload);
    await options.onStaged?.();
    await verifyPreparedSiteAssets(source);
    await chmod(stagingPath, 0o755);
    // mkdir is the exclusive claim: it fails if another process creates the target during staging.
    reservationAttempted = true;
    await mkdir(target, { mode: 0o700 });
    reservationCreated = true;
    reservationIdentity = await directoryIdentity(target);
    if (!sameDirectoryIdentity(reservationIdentity, await directoryIdentity(target))) {
      throw new Error('output reservation changed before publication');
    }
    await rename(stagingPath, target);
    staged = false;
    reservationCreated = false;
    return {
      directory: target,
      artifactType,
      files: payload.map(({ path: filePath, bytes }) => ({ path: filePath, sha256: hashBytes(bytes), size: bytes.length })),
    };
  } catch (error) {
    if (staged) {
      let retainedReservation: string | undefined;
      if (reservationCreated) {
        if (!reservationIdentity) retainedReservation = target;
        else {
          try {
            if (sameDirectoryIdentity(reservationIdentity, await directoryIdentity(target))) await rmdir(target);
            else retainedReservation = target;
          } catch { retainedReservation = target; }
        }
      }
      const message = reservationAttempted && !reservationCreated && (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? `bundle output target already exists: ${target}`
        : error instanceof Error ? error.message : String(error);
      throw new SiteWriteError(message, stagingPath, retainedReservation, { cause: error });
    }
    throw error;
  }
}

function buildBundleFiles(source: PreparedSiteSource, artifact: CompiledSite | ThemeArtifact): Array<{ path: string; bytes: Buffer }> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const add = (filePath: string, value: Uint8Array | string): void => {
    assertRelativePath(filePath);
    files.push({ path: filePath, bytes: typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value) });
  };
  add('site.intent.json', `${JSON.stringify(source.sourceIntent, null, 2)}\n`);
  for (const asset of source.assets) {
    assertBoundedAsset(asset.id, asset.bytes);
    const bytes = Buffer.from(asset.bytes);
    if (hashBytes(bytes) !== asset.sha256) throw new Error(`prepared source asset ${asset.id} no longer matches its SHA-256`);
    add(`source/assets/${asset.path}`, bytes);
  }

  for (const file of artifact.themeFiles) addVerifiedFile(files, 'theme', file);

  const compiledRecord = 'pendingPageBindings' in artifact
    ? {
      type: 'theme', artifactIdentity: artifact.artifactIdentity, sourceIdentity: source.sourceIdentity,
      targetBindings: artifact.targetBindings,
      targetBindingFingerprint: artifact.targetBindingFingerprint,
      ...(artifact.themeAssetBaseUrl !== undefined ? { themeAssetBaseUrl: artifact.themeAssetBaseUrl } : {}),
      pendingPageBindings: artifact.pendingPageBindings, diagnostics: artifact.diagnostics,
      inventory: artifact.inventory,
    }
    : {
      type: 'site', artifactIdentity: artifact.artifactIdentity, sourceIdentity: source.sourceIdentity,
      targetBindings: artifact.targetBindings, targetBindingFingerprint: artifact.targetBindingFingerprint,
      ...(artifact.themeAssetBaseUrl !== undefined ? { themeAssetBaseUrl: artifact.themeAssetBaseUrl } : {}),
      pages: artifact.pages, diagnostics: artifact.diagnostics, inventory: artifact.inventory,
    };
  const sorted = sortBundleFiles(files);
  assertUniqueOutputPaths(sorted);
  const inventory = sorted.map(({ path: filePath, bytes }) => ({ path: filePath, sha256: hashBytes(bytes), size: bytes.length }));
  sorted.push({ path: 'site.manifest.json', bytes: Buffer.from(`${JSON.stringify({
    formatVersion: 1,
    ...compiledRecord,
    artifactType: 'pendingPageBindings' in artifact ? 'theme' : 'site',
    siteId: source.sourceIntent.siteId,
    artifactIdentity: artifact.artifactIdentity,
    sourceIdentity: source.sourceIdentity,
    sourceAssets: source.assets.map(({ id, path: sourcePath, kind, role, sha256, bytes }) => ({ id, path: sourcePath, kind, role, sha256, size: bytes.byteLength })),
    bundleFiles: inventory,
  }, null, 2)}\n`, 'utf8') });
  assertUniqueOutputPaths(sorted);
  return sorted;
}

function addVerifiedFile(files: Array<{ path: string; bytes: Buffer }>, prefix: string, file: SiteFile): void {
  const bytes = Buffer.from(file.bytes);
  if (hashBytes(bytes) !== file.sha256) throw new Error(`compiled file ${file.path} no longer matches its SHA-256`);
  files.push({ path: `${prefix}/${file.path}`, bytes });
}

async function writeStagedFiles(stagingPath: string, files: Array<{ path: string; bytes: Buffer }>): Promise<void> {
  for (const file of files) {
    assertRelativePath(file.path);
    const absolute = path.join(stagingPath, ...file.path.split('/'));
    const relative = path.relative(stagingPath, absolute);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`bundle file path escapes staging: ${file.path}`);
    const publicThemeFile = file.path.startsWith('theme/');
    const directoryMode = publicThemeFile ? 0o755 : 0o700;
    const fileMode = publicThemeFile ? 0o644 : 0o600;
    const parentDirectory = path.dirname(absolute);
    await mkdir(parentDirectory, { recursive: true, mode: directoryMode });
    if (publicThemeFile) await chmodThemeDirectories(stagingPath, parentDirectory);
    const handle = await open(absolute, 'wx', fileMode);
    try { await handle.writeFile(file.bytes); await handle.chmod(fileMode); await handle.sync(); } finally { await handle.close(); }
  }
}

async function chmodThemeDirectories(stagingPath: string, directory: string): Promise<void> {
  let current = directory;
  while (current.startsWith(`${stagingPath}${path.sep}`)) {
    await chmod(current, 0o755);
    current = path.dirname(current);
  }
}

async function assertSafeExistingDirectory(directory: string): Promise<void> {
  const root = path.parse(directory).root;
  const parts = directory.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`bundle output parent contains a symlink or non-directory: ${current}`);
  }
}

async function assertAbsentTarget(target: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(`bundle output target already exists: ${target}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('bundle output target already exists:')) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

interface DirectoryIdentity {
  dev: string;
  ino: string;
  mode: number;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`bundle output reservation changed type: ${directory}`);
  return { dev: String(info.dev), ino: String(info.ino), mode: Number(info.mode) };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function assertArtifactSource(source: PreparedSiteSource, artifact: CompiledSite | ThemeArtifact): void {
  if (JSON.stringify(artifact.sourceIntent) !== JSON.stringify(source.sourceIntent)) throw new Error('compiled artifact does not match the prepared site intent');
  const compiledAssets = new Map(artifact.sourceAssets.map((asset) => [asset.id, asset]));
  if (compiledAssets.size !== source.assets.length || source.assets.some((asset) => {
    const compiled = compiledAssets.get(asset.id);
    return !compiled || !isBoundedAssetBytes(asset.bytes) || !isBoundedAssetBytes(compiled.bytes)
      || compiled.sha256 !== asset.sha256 || compiled.path !== asset.path || !Buffer.from(compiled.bytes).equals(Buffer.from(asset.bytes));
  })) throw new Error('compiled artifact does not retain the exact prepared source assets');
  if (!artifact.artifactIdentity || !artifact.targetBindingFingerprint || !artifact.targetBindings
    || !Array.isArray(artifact.themeFiles) || ('assets' in artifact && !Array.isArray(artifact.assets))) {
    throw new Error('compiled artifact is incomplete');
  }
  if (calculateSiteArtifactIdentity(source, artifact) !== artifact.artifactIdentity) {
    throw new Error('compiled artifact no longer matches its compiler identity');
  }
}

function assertBoundedAsset(id: string, bytes: Uint8Array): void {
  if (!isBoundedAssetBytes(bytes)) throw new Error(`prepared source asset ${id} is empty or exceeds 20 MiB`);
}

function isBoundedAssetBytes(bytes: unknown): bytes is Uint8Array {
  return bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024;
}

function assertRelativePath(value: string): void {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || /^[a-z]:/i.test(value) || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`bundle file path is unsafe: ${value}`);
  }
}

function assertUniqueOutputPaths(files: Array<{ path: string }>): void {
  const seen = new Map<string, string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    const prior = seen.get(key);
    if (prior) throw new Error(`bundle output path collides with ${prior}: ${file.path}`);
    seen.set(key, file.path);
  }
}

function sortBundleFiles<T extends { path: string }>(files: T[]): T[] {
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
