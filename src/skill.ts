import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillScope = 'project' | 'user';
export type SkillTarget = 'all' | 'agents' | 'claude';

export interface SkillInstallOptions {
  cwd: string;
  home: string;
  packageVersion: string;
  directory?: string;
  scope?: SkillScope;
  target?: SkillTarget;
  dryRun?: boolean;
  force?: boolean;
}

export interface SkillInstallResult {
  destination: string;
  status: 'installed' | 'updated' | 'unchanged';
  dryRun: boolean;
  warnings: string[];
}

interface BundleFile {
  path: string;
  content: Buffer;
  mode: number;
}

interface InstallManifest {
  schemaVersion: 1;
  skill: 'block-runner';
  source: 'skills/block-runner';
  packageVersion: string;
  scope: SkillScope | 'custom';
  target: Exclude<SkillTarget, 'all'> | 'custom';
  files: Record<string, { sha256: string; mode: number }>;
}

interface InstallPlan {
  destination: string;
  files: BundleFile[];
  manifestContent: Buffer;
  status: SkillInstallResult['status'];
  warnings: string[];
}

const SKILL_NAME = 'block-runner';
const MANIFEST_NAME = '.block-runner-install.json';
const SOURCE_DIRECTORY = fileURLToPath(new URL('../skills/block-runner/', import.meta.url));

export async function readCanonicalSkillGuide(): Promise<string> {
  const guidePath = path.join(SOURCE_DIRECTORY, 'references', 'GUIDE.md');
  try {
    return await readFile(guidePath, 'utf8');
  } catch {
    throw new Error(`skill source file is missing: ${guidePath}`);
  }
}

export async function validateCanonicalSkill(): Promise<void> {
  validateBundle(await readBundle());
}

export async function installCanonicalSkill(options: SkillInstallOptions): Promise<SkillInstallResult[]> {
  const sourceFiles = await readBundle();
  validateBundle(sourceFiles);

  const installedFiles = sourceFiles.map((file) => ({
    ...file,
    content: pinPackageVersion(file, options.packageVersion),
  }));
  const roots = resolveSkillRoots(options);

  // Plan every target before writing any of them. A conflict in one target must not leave an
  // `--target all` installation half-applied in the other target.
  const plans: InstallPlan[] = [];
  for (const root of roots) {
    plans.push(await planInstall(path.join(root, SKILL_NAME), installedFiles, options));
  }

  if (!options.dryRun) {
    // Catch normal permission failures across every projection before the first write. This is
    // still not a filesystem transaction (disk and device failures can happen after preflight),
    // but a read-only second target must not leave the first target installed by surprise.
    for (const plan of plans) {
      if (plan.status !== 'unchanged') {
        await preflightInstallPlan(plan);
      }
    }
    for (const plan of plans) {
      if (plan.status !== 'unchanged') {
        await applyInstallPlan(plan);
      }
    }
  }

  return plans.map((plan) => ({
    destination: plan.destination,
    status: plan.status,
    dryRun: options.dryRun ?? false,
    warnings: plan.warnings,
  }));
}

export function resolveSkillRoots(
  options: Pick<SkillInstallOptions, 'cwd' | 'home' | 'directory' | 'scope' | 'target'>,
): string[] {
  if (options.directory) {
    if (options.scope || options.target) {
      throw new Error('--dir cannot be combined with --scope or --target');
    }
    return [path.resolve(options.cwd, options.directory)];
  }

  const scope = options.scope ?? 'project';
  const target = options.target ?? 'all';
  if (scope !== 'project' && scope !== 'user') {
    throw new Error(`invalid skill scope: ${scope}`);
  }
  if (target !== 'all' && target !== 'agents' && target !== 'claude') {
    throw new Error(`invalid skill target: ${target}`);
  }
  const base = path.resolve(scope === 'user' ? options.home : options.cwd);
  const roots: string[] = [];

  if (target === 'all' || target === 'agents') {
    roots.push(path.join(base, '.agents', 'skills'));
  }
  if (target === 'all' || target === 'claude') {
    roots.push(path.join(base, '.claude', 'skills'));
  }

  return roots;
}

async function readBundle(): Promise<BundleFile[]> {
  if (!existsSync(SOURCE_DIRECTORY)) {
    throw new Error(`skill source directory is missing: ${SOURCE_DIRECTORY}`);
  }

  const files: BundleFile[] = [];

  async function walk(directory: string, prefix = ''): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({
          path: relativePath,
          content: await readFile(absolutePath),
          mode: (await stat(absolutePath)).mode & 0o777,
        });
      } else {
        throw new Error(`skill source contains an unsupported filesystem entry: ${absolutePath}`);
      }
    }
  }

  await walk(SOURCE_DIRECTORY);
  return files;
}

function validateBundle(files: BundleFile[]): void {
  for (const file of files) {
    if (path.posix.isAbsolute(file.path) || file.path.split('/').includes('..')) {
      throw new Error(`canonical skill is invalid: unsafe bundle path: ${file.path}`);
    }
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const skill = byPath.get('SKILL.md');
  if (!skill) {
    throw new Error('canonical skill is invalid: SKILL.md is missing');
  }

  const sourceDirectoryName = path.basename(path.resolve(SOURCE_DIRECTORY));
  const content = skill.content.toString('utf8');
  if (!content.startsWith('---\n')) {
    throw new Error('canonical skill is invalid: SKILL.md frontmatter must begin at byte 0');
  }

  const frontmatterEnd = content.indexOf('\n---\n', 4);
  if (frontmatterEnd === -1) {
    throw new Error('canonical skill is invalid: SKILL.md frontmatter is not closed');
  }

  const frontmatter = content.slice(4, frontmatterEnd);
  const name = readFrontmatterField(frontmatter, 'name');
  const description = readFrontmatterField(frontmatter, 'description');
  const compatibility = readFrontmatterField(frontmatter, 'compatibility');

  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(
      'canonical skill is invalid: name must be a lowercase hyphenated value of at most 64 characters',
    );
  }
  if (name !== sourceDirectoryName || name !== SKILL_NAME) {
    throw new Error(
      `canonical skill is invalid: name ${JSON.stringify(name)} must match directory ${JSON.stringify(sourceDirectoryName)}`,
    );
  }
  if (!description || description.length > 1024) {
    throw new Error('canonical skill is invalid: description must contain 1 to 1024 characters');
  }
  if (!compatibility) {
    throw new Error('canonical skill is invalid: compatibility requirements are missing');
  }

  const referencedPaths = new Set(
    [...content.matchAll(/\b(?:references|scripts|assets)\/[A-Za-z0-9._/-]+/g)].map((match) => match[0]),
  );
  for (const referencedPath of referencedPaths) {
    if (!byPath.has(referencedPath)) {
      throw new Error(`canonical skill is invalid: referenced file is missing: ${referencedPath}`);
    }
  }
  if (!byPath.has('references/GUIDE.md')) {
    throw new Error('canonical skill is invalid: references/GUIDE.md is missing');
  }
}

function readFrontmatterField(frontmatter: string, key: string): string | undefined {
  const lines = frontmatter.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) {
    return undefined;
  }

  const inlineValue = lines[index]!.slice(key.length + 1).trim();
  if (!/^[>|][+-]?$/.test(inlineValue)) {
    return unquote(inlineValue);
  }

  const values: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && !/^\s/.test(line)) {
      break;
    }
    if (line.trim()) {
      values.push(line.trim());
    }
  }
  return values.join(' ');
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function pinPackageVersion(file: BundleFile, packageVersion: string): Buffer {
  if (!file.path.endsWith('.md')) {
    return file.content;
  }
  return Buffer.from(
    file.content.toString('utf8').replace(
      /block-runner@latest(?!\s+skill\b)/g,
      `block-runner@${packageVersion}`,
    ),
  );
}

async function planInstall(
  destination: string,
  files: BundleFile[],
  options: SkillInstallOptions,
): Promise<InstallPlan> {
  const installRoot = path.dirname(destination);
  const resolvedDestination = await resolveFilesystemPath(destination);
  const resolvedSource = await realpath(SOURCE_DIRECTORY);
  if (
    resolvedDestination === resolvedSource
    || resolvedDestination.startsWith(`${resolvedSource}${path.sep}`)
  ) {
    throw new Error('refusing to install over the canonical source skill; choose another --dir');
  }
  await assertNoSymlinkedInstallPath(installRoot, installPathAnchor(installRoot, options));
  const destinationExists = existsSync(destination);
  if (destinationExists) {
    const destinationStat = await lstat(destination);
    if (destinationStat.isSymbolicLink()) {
      throw new Error(`refusing to install through a symbolic-link destination: ${destination}`);
    }
    if (!destinationStat.isDirectory()) {
      throw new Error(`skill destination is not a directory: ${destination}`);
    }
  }
  const manifest = await readManifest(destination, options.force ?? false);
  const conflicts: string[] = [];
  const changedFiles: BundleFile[] = [];

  for (const file of files) {
    const target = destinationPath(destination, file.path);
    const resolvedTarget = await resolveFilesystemPath(target);
    if (!resolvedTarget.startsWith(`${resolvedDestination}${path.sep}`)) {
      conflicts.push(`${target} resolves outside the skill destination`);
      continue;
    }
    if (!existsSync(target)) {
      changedFiles.push(file);
      continue;
    }

    let current: Buffer;
    let currentMode: number;
    try {
      const targetStat = await lstat(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new Error('not a regular file');
      }
      current = await readFile(target);
      currentMode = targetStat.mode & 0o777;
    } catch {
      conflicts.push(`${target} is not a readable regular file`);
      continue;
    }
    if (current.equals(file.content) && currentMode === file.mode) {
      continue;
    }

    const managedFile = manifest?.files[file.path];
    const isUnmodifiedManagedFile = managedFile?.sha256 === hash(current)
      && managedFile.mode === currentMode;
    if (!options.force && !isUnmodifiedManagedFile) {
      conflicts.push(`${target} has local or unmanaged changes`);
      continue;
    }
    changedFiles.push(file);
  }

  if (conflicts.length > 0) {
    throw new Error(
      `refusing to overwrite skill files:\n${conflicts.map((conflict) => `- ${conflict}`).join('\n')}\nRe-run with --force to replace them.`,
    );
  }

  const manifestValue: InstallManifest = {
    schemaVersion: 1,
    skill: SKILL_NAME,
    source: 'skills/block-runner',
    packageVersion: options.packageVersion,
    scope: options.directory ? 'custom' : (options.scope ?? 'project'),
    target: options.directory ? 'custom' : targetForDestination(destination),
    files: Object.fromEntries(
      files.map((file) => [file.path, { sha256: hash(file.content), mode: file.mode }]),
    ),
  };
  const manifestContent = Buffer.from(`${JSON.stringify(manifestValue, null, 2)}\n`);
  const manifestPath = path.join(destination, MANIFEST_NAME);
  const manifestChanged = !existsSync(manifestPath)
    || !(await readFile(manifestPath)).equals(manifestContent);
  const warnings = Object.keys(manifest?.files ?? {})
    .filter((file) => (
      !Object.prototype.hasOwnProperty.call(manifestValue.files, file)
      && existsSync(destinationPath(destination, file))
    ))
    .map((file) => `preserved stale managed file ${destinationPath(destination, file)}`);
  const unmanagedRootGuide = path.join(destination, 'GUIDE.md');
  if (!manifest && existsSync(unmanagedRootGuide)) {
    warnings.push(
      `preserved unmanaged file ${unmanagedRootGuide}; the canonical guide now lives at references/GUIDE.md`,
    );
  }
  const hasChanges = changedFiles.length > 0 || manifestChanged;

  return {
    destination,
    files: changedFiles,
    manifestContent,
    status: !destinationExists ? 'installed' : hasChanges ? 'updated' : 'unchanged',
    warnings,
  };
}

async function readManifest(destination: string, force: boolean): Promise<InstallManifest | undefined> {
  const manifestPath = path.join(destination, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    return undefined;
  }

  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`skill install manifest is not a regular file: ${manifestPath}`);
  }

  try {
    const value = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<InstallManifest>;
    if (
      value.schemaVersion !== 1
      || value.skill !== SKILL_NAME
      || value.source !== 'skills/block-runner'
      || typeof value.packageVersion !== 'string'
      || !['project', 'user', 'custom'].includes(value.scope ?? '')
      || !['agents', 'claude', 'custom'].includes(value.target ?? '')
      || !isManifestFiles(value.files)
    ) {
      throw new Error('unexpected manifest shape');
    }
    return value as InstallManifest;
  } catch {
    if (force) {
      return undefined;
    }
    throw new Error(`skill install manifest is invalid: ${manifestPath}. Re-run with --force to replace it.`);
  }
}

function isManifestFiles(value: unknown): value is InstallManifest['files'] {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.values(value).every((item) => (
        item
        && typeof item === 'object'
        && typeof (item as { sha256?: unknown }).sha256 === 'string'
        && typeof (item as { mode?: unknown }).mode === 'number'
      )),
  );
}

async function applyInstallPlan(plan: InstallPlan): Promise<void> {
  await mkdir(plan.destination, { recursive: true });
  for (const file of plan.files) {
    const target = destinationPath(plan.destination, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode: file.mode });
    await chmod(target, file.mode);
  }
  await writeFile(path.join(plan.destination, MANIFEST_NAME), plan.manifestContent);
}

async function preflightInstallPlan(plan: InstallPlan): Promise<void> {
  const targets = [
    ...plan.files.map((file) => destinationPath(plan.destination, file.path)),
    path.join(plan.destination, MANIFEST_NAME),
  ];

  for (const target of targets) {
    let writablePath = target;
    let flags = constants.W_OK;
    while (!existsSync(writablePath)) {
      const parent = path.dirname(writablePath);
      if (parent === writablePath) {
        break;
      }
      writablePath = parent;
      flags = constants.W_OK | constants.X_OK;
    }
    try {
      await access(writablePath, flags);
    } catch {
      throw new Error(`skill install path is not writable: ${writablePath}`);
    }
  }
}

function destinationPath(destination: string, relativePath: string): string {
  return path.join(destination, ...relativePath.split('/'));
}

async function resolveFilesystemPath(target: string): Promise<string> {
  const missingSegments: string[] = [];
  let existing = path.resolve(target);
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      break;
    }
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  if (missingSegments.length > 0 && !(await stat(existing)).isDirectory()) {
    throw new Error(`path ancestor is not a directory: ${existing}`);
  }
  return path.join(await realpath(existing), ...missingSegments);
}

function installPathAnchor(root: string, options: SkillInstallOptions): string {
  const candidates = [path.resolve(options.cwd), path.resolve(options.home)];
  return candidates.find((candidate) => isPathWithin(root, candidate)) ?? path.dirname(root);
}

async function assertNoSymlinkedInstallPath(target: string, anchor: string): Promise<void> {
  const resolvedTarget = path.resolve(target);
  const resolvedAnchor = path.resolve(anchor);
  const relative = path.relative(resolvedAnchor, resolvedTarget);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return;
  }

  let current = resolvedAnchor;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      return;
    }
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink()) {
      throw new Error(`refusing to install through a symbolic-link path: ${current}`);
    }
    if (!currentStat.isDirectory()) {
      throw new Error(`path ancestor is not a directory: ${current}`);
    }
  }
}

function isPathWithin(target: string, base: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function targetForDestination(destination: string): 'agents' | 'claude' {
  const skillsRoot = path.dirname(destination);
  return path.basename(path.dirname(skillsRoot)) === '.claude' ? 'claude' : 'agents';
}

function hash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
