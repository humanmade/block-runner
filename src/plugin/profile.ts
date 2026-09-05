import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ALLOW_SCRIPTS_ENV_KEYS = ['npm_config_allow_scripts', 'NPM_CONFIG_ALLOW_SCRIPTS'] as const;

/**
 * npm projects a user-level allow-scripts setting into every npm-run child process. A generated
 * plugin is a separate package, so its lockfile resolution must not inherit that projection and
 * accidentally reject ordinary WordPress dependencies with EALLOWSCRIPTS. Remove only an exact
 * match; an explicit value that differs from the user config remains in force.
 */
export function removeMatchingAllowScriptsProjection(
  environment: NodeJS.ProcessEnv,
  userConfigValue: string,
): NodeJS.ProcessEnv {
  const projected = ALLOW_SCRIPTS_ENV_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(environment, key))
    .map((key) => [key, environment[key]] as const)
    .filter(([, value]) => value !== undefined);
  if (projected.length === 0 || userConfigValue === '' || userConfigValue === 'undefined') {
    return { ...environment };
  }
  if (!projected.every(([, value]) => value === userConfigValue)) {
    return { ...environment };
  }
  const childEnvironment = { ...environment };
  for (const key of ALLOW_SCRIPTS_ENV_KEYS) delete childEnvironment[key];
  return childEnvironment;
}

/**
 * Return the environment for a generated-plugin npm child. The readback runs in the same cwd as
 * that child and with both projected keys absent, so a project-local config or an explicit caller
 * override cannot be mistaken for the user-level projection. A failed readback preserves policy.
 */
export async function npmEnvironmentForGeneratedPlugin(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const probeEnvironment = { ...environment };
  const hasProjection = ALLOW_SCRIPTS_ENV_KEYS.some((key) => Object.prototype.hasOwnProperty.call(probeEnvironment, key));
  if (!hasProjection) return { ...environment };
  for (const key of ALLOW_SCRIPTS_ENV_KEYS) delete probeEnvironment[key];
  try {
    const { stdout } = await execFileAsync('npm', ['config', 'get', 'allow-scripts', '--location=user'], {
      cwd,
      env: probeEnvironment,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    return removeMatchingAllowScriptsProjection(environment, stdout.trim());
  } catch {
    // A failed readback is not permission to bypass an explicit environment policy.
    return { ...environment };
  }
}

/**
 * The single host profile this preview recognises.  Deliberately accepting only a small,
 * explainable shape is safer than putting a source directory into an arbitrary webpack build.
 */
export const WP_SCRIPTS_PROFILE = 'wordpress-scripts-block-metadata-v1' as const;
export const STANDALONE_WP_SCRIPTS_VERSION = '34.2.0' as const;

export type PluginRegistrationStrategy = 'direct' | 'metadata-collection';
export type PluginPlanMode = 'existing' | 'standalone';
export type PluginFileOperation = 'create' | 'modify';
export type PluginFileContent = string | Buffer;

export interface GeneratedBlockPackage {
  /** The block name stored in block.json, such as `acme/feature-grid`. */
  name: string;
  /** Files below the generated block directory. The keys must be safe POSIX relative paths. */
  files: Readonly<Record<string, PluginFileContent>>;
}

export interface WpScriptsPluginProfile {
  kind: 'recognized';
  profile: typeof WP_SCRIPTS_PROFILE;
  root: string;
  wpScriptsVersion: string;
  packageFile: string;
  buildScript: string;
  sourceRoot: string;
  buildRoot: string;
  entryDiscovery: string;
  registration: PluginRegistrationStrategy;
  registrationFile: string;
  /** The source-relative directory in which a new block belongs. */
  blockDirectory: string;
  /** The build-relative directory produced for a new block. */
  buildDirectory: string;
  metadataCollection?: {
    directory: string;
    manifest: string;
    /** The leaf block directory used by wp-scripts as the metadata collection key. */
    key: string;
  };
}

export interface UnsupportedPluginProfile {
  kind: 'absent' | 'unsupported' | 'ambiguous';
  root: string;
  reason: string;
  /** A caller can show this exact option without guessing whether fallback is safe. */
  standaloneAvailable: true;
}

export type PluginProfile = WpScriptsPluginProfile | UnsupportedPluginProfile;

export interface PluginTouchedFile {
  /** Absolute file path. This is intentionally suitable for an approval UI. */
  path: string;
  relativePath: string;
  operation: PluginFileOperation;
  /** Raw bytes are retained so generated runtime assets are never text-decoded. */
  content: Buffer;
  /** Existing file content from the read-only inspection, never a hash-only blind write. */
  previousContent?: Buffer;
  requiresSeparateAuthorization: boolean;
}

export interface PluginOutputPlan {
  mode: PluginPlanMode;
  targetDirectory: string;
  block: {
    name: string;
    directory: string;
    buildDirectory: string;
  };
  profile?: WpScriptsPluginProfile;
  touchedFiles: PluginTouchedFile[];
  notes: string[];
  /** Stable identity for a preview/confirmation layer. */
  fingerprint: string;
}

export interface WritePluginOutputOptions {
  /**
   * Exact absolute paths from `touchedFiles` that a user separately approved for replacement.
   * New files do not need this authority. Package and PHP bootstrap edits always do.
   */
  authorizedReplacements?: readonly string[];
  /**
   * Test-only failure injection. A value of 1 throws immediately after the first destination
   * file is published, before the next file can be touched.
   */
  failAfterPublishStep?: number;
  /**
   * Called immediately after each individual destination file is published. Throwing from this
   * hook simulates an interrupted multi-file publication and returns a recovery inventory.
   */
  onPublished?: (entry: PublicationRecoveryEntry, recovery: PublicationRecovery) => void | Promise<void>;
  /**
   * Test-only hook after a target has been stably observed by final validation. The complete set
   * is observed again before success so a later read cannot hide a changed earlier target.
   */
  onFinalValidationTarget?: (entry: PublicationRecoveryEntry, validated: ReadonlyArray<PublicationRecoveryEntry>) => void | Promise<void>;
}

export interface WritePluginOutputResult {
  directory: string;
  written: string[];
  fingerprint: string;
}

/** A single destination file in a partial-publication inventory. */
export interface PublicationRecoveryEntry {
  path: string;
  /** SHA-256 hashes are prefixed so callers never mistake them for arbitrary identifiers. */
  beforeHash?: string;
  afterHash: string;
  /** The prior bytes are present only for an approved replacement, never for a new file. */
  beforeContent?: Buffer;
}

/**
 * A bounded report for a publication that did not complete. The private staging directory named
 * by recordPath contains its JSON inventory and staged bytes, but no additional published
 * destination files; it can be supplied to retryPluginPublication later.
 */
export interface PublicationRecovery {
  directory: string;
  completed: PublicationRecoveryEntry[];
  pending: PublicationRecoveryEntry[];
  /** The subset of completed files whose prior bytes were replaced. */
  replacements: PublicationRecoveryEntry[];
  recordPath?: string;
}

/** A write failed after at least one destination file may have been published. */
export class PublicationInterruptedError extends Error {
  readonly recovery: PublicationRecovery;

  constructor(message: string, recovery: PublicationRecovery, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublicationInterruptedError';
    this.recovery = recovery;
  }
}

/** A destination previously published by this operation changed before completion. */
class PublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationConflictError';
  }
}

export class UnsupportedPluginLayoutError extends Error {
  readonly profile: UnsupportedPluginProfile;

  constructor(profile: UnsupportedPluginProfile) {
    super(`${profile.reason} No files were written. Generate a standalone plugin instead.`);
    this.name = 'UnsupportedPluginLayoutError';
    this.profile = profile;
  }
}

/**
 * Detect the one supported existing-plugin profile, without changing the filesystem.  The
 * report includes the script version, source/build roots, discovery method, and registration
 * strategy so an approval screen has facts rather than inferred destination paths.
 */
export async function detectWpScriptsPlugin(rootDirectory: string): Promise<PluginProfile> {
  const root = path.resolve(rootDirectory);
  const rootStats = await lstatMaybe(root);
  if (rootStats?.isSymbolicLink()) {
    return unsupported('unsupported', root, 'The requested host root is a symbolic link.');
  }
  const packageFile = path.join(root, 'package.json');
  if (!existsSync(packageFile)) {
    return unsupported('absent', root, 'No package.json was found at the requested host root.');
  }
  const packageStats = await lstatMaybe(packageFile);
  if (!packageStats?.isFile() || packageStats.isSymbolicLink()) {
    return unsupported('unsupported', root, 'The host package.json is not a regular file.');
  }

  let packageText: string;
  let packageJson: Record<string, unknown>;
  try {
    packageText = await readFile(packageFile, 'utf8');
    packageJson = asObject(JSON.parse(packageText), 'package.json must contain an object');
  } catch (error) {
    return unsupported(
      'unsupported',
      root,
      `Could not read a valid package.json (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const dependencies = { ...asObjectOrEmpty(packageJson.dependencies), ...asObjectOrEmpty(packageJson.devDependencies) };
  const wpScriptsVersion = typeof dependencies['@wordpress/scripts'] === 'string'
    ? dependencies['@wordpress/scripts']
    : undefined;
  if (wpScriptsVersion !== STANDALONE_WP_SCRIPTS_VERSION) {
    return unsupported(
      'unsupported',
      root,
      `This package must declare @wordpress/scripts exactly at ${STANDALONE_WP_SCRIPTS_VERSION}.`,
    );
  }

  const scripts = asObjectOrEmpty(packageJson.scripts);
  const buildScript = typeof scripts.build === 'string' ? scripts.build : undefined;
  if (!buildScript || /[;&|><`$]/.test(buildScript)) {
    return unsupported('unsupported', root, 'The package build script is not a direct wp-scripts build command.');
  }
  const parsedBuild = parseWpScriptsBuild(buildScript);
  if (!parsedBuild) {
    return unsupported(
      'unsupported',
      root,
      'The package build script must be a direct wp-scripts build command with no positional entries and only supported profile flags.',
    );
  }
  const automaticWebpackConfig = await findAutomaticWebpackConfig(root);
  if (automaticWebpackConfig) {
    return unsupported(
      'unsupported',
      root,
      `The automatically loaded webpack configuration ${automaticWebpackConfig} is outside the supported wp-scripts profile.`,
    );
  }

  const sourceRoot = parsedBuild.sourcePath ?? 'src';
  const buildRoot = parsedBuild.outputPath ?? 'build';
  if (!isSafeRelativeDirectory(sourceRoot) || !isSafeRelativeDirectory(buildRoot)) {
    return unsupported('unsupported', root, 'The wp-scripts source or output path is not a safe relative directory.');
  }
  const sourceDirectory = path.join(root, sourceRoot);
  const sourceStats = await lstatMaybe(sourceDirectory);
  if (!sourceStats?.isDirectory() || sourceStats.isSymbolicLink()) {
    return unsupported('unsupported', root, `The declared source root ${JSON.stringify(sourceRoot)} is not a regular directory.`);
  }

  const blockMetadata = await findBlockMetadata(sourceDirectory);
  if (blockMetadata.length === 0) {
    return unsupported(
      'unsupported',
      root,
      `No block.json file was found below the declared wp-scripts source root ${JSON.stringify(sourceRoot)}.`,
    );
  }
  const blockDirectories = new Set(blockMetadata.map((file) => path.posix.dirname(file)));
  if (blockDirectories.size !== blockMetadata.length) {
    return unsupported('ambiguous', root, 'More than one block.json was found in a source directory.');
  }
  // A source root can contain a block namespace folder (for example `src/blocks/foo`). Preserve
  // that entry layout by placing the new sibling below the common parent of detected entries.
  const entryParent = commonDirectory([...blockDirectories].map((directory) => path.posix.dirname(directory)));
  const blockDirectory = joinPosix(sourceRoot, entryParent);
  const buildDirectory = joinPosix(buildRoot, entryParent);

  const phpFiles = await findPhpFiles(root);
  const direct = await findDirectRegistration(root, phpFiles, buildRoot);
  const collection = await findCollectionRegistration(root, phpFiles, buildRoot, buildDirectory);
  if (direct && collection) {
    return unsupported('ambiguous', root, 'Both direct registration and metadata-collection registration were found.');
  }
  if (!direct && !collection) {
    return unsupported(
      'unsupported',
      root,
      `No supported PHP registration bootstrap was found for the ${JSON.stringify(buildRoot)} build root.`,
    );
  }

  const registration = direct ? 'direct' : 'metadata-collection';
  const registrationFile = direct?.file ?? collection!.file;
  return {
    kind: 'recognized',
    profile: WP_SCRIPTS_PROFILE,
    root,
    wpScriptsVersion,
    packageFile,
    buildScript,
    sourceRoot,
    buildRoot,
    entryDiscovery: `wp-scripts scans block.json recursively below ${sourceRoot}; each metadata directory is an entry (new entries belong below ${blockDirectory}).`,
    registration,
    registrationFile,
    // WordPress scripts maps a source metadata path `blocks/example/block.json` to the same path
    // below its output root. Keep this an explicit profile fact, not a string guess at write time.
    blockDirectory,
    buildDirectory,
    ...(collection
      ? {
          metadataCollection: {
            directory: path.join(root, buildDirectory),
            manifest: path.join(root, buildRoot, 'blocks-manifest.php'),
            key: '',
          },
        }
      : {}),
  };
}

/**
 * Plan an existing integration. Unknown and ambiguous layouts intentionally throw before a
 * target is created; the attached profile explicitly offers standalone output.
 */
export async function planExistingPluginOutput(
  hostDirectory: string,
  generated: GeneratedBlockPackage,
): Promise<PluginOutputPlan> {
  const profile = await detectWpScriptsPlugin(hostDirectory);
  if (profile.kind !== 'recognized') {
    throw new UnsupportedPluginLayoutError(profile);
  }
  const block = normalizeGeneratedBlock(generated);
  const blockLeaf = blockDirectoryName(block.name);
  const sourceDirectory = path.join(profile.root, ...profile.blockDirectory.split('/'), blockLeaf);
  const buildDirectory = path.join(profile.root, ...profile.buildDirectory.split('/'), blockLeaf);
  const touchedFiles: PluginTouchedFile[] = [];

  for (const [relativePath, content] of Object.entries(block.files).sort(([left], [right]) => left.localeCompare(right))) {
    const target = path.join(sourceDirectory, ...relativePath.split('/'));
    touchedFiles.push(await makeTouchedFile(profile.root, target, `${profile.blockDirectory}/${blockLeaf}/${relativePath}`, content));
  }

  const notes = [
    `Block source target: ${sourceDirectory}`,
    `Build target after npm run build: ${buildDirectory}`,
    `Entry discovery: ${profile.entryDiscovery}`,
  ];

  if (profile.registration === 'direct') {
    const bootstrap = (await readFile(profile.registrationFile)).toString('utf8');
    const direct = directInsertion(bootstrap, profile.buildDirectory, blockLeaf);
    if (!direct) {
      throw new UnsupportedPluginLayoutError(unsupported(
        'unsupported',
        profile.root,
        `The direct registration bootstrap ${profile.registrationFile} cannot be extended safely.`,
      ));
    }
    touchedFiles.push(await makeModifiedFile(profile.root, profile.registrationFile, direct));
    notes.push(`Direct registration target: ${buildDirectory}`);
  } else {
    const bootstrap = (await readFile(profile.registrationFile)).toString('utf8');
    const metadataCollectionKey = blockLeaf;
    const update = collectionBootstrapUpdate(bootstrap, profile.root, profile.buildRoot, profile.buildDirectory, blockLeaf);
    if (!update) {
      throw new UnsupportedPluginLayoutError(unsupported(
        'unsupported',
        profile.root,
        `The metadata collection bootstrap ${profile.registrationFile} cannot be extended safely.`,
      ));
    }
    if (update !== bootstrap) {
      touchedFiles.push(await makeModifiedFile(profile.root, profile.registrationFile, update));
    }
    if (!hasBlocksManifest(profile.buildScript)) {
      const packageText = (await readFile(profile.packageFile)).toString('utf8');
      const updatedPackage = appendBlocksManifest(packageText);
      if (!updatedPackage) {
        throw new UnsupportedPluginLayoutError(unsupported(
          'unsupported',
          profile.root,
          'The build script could not be updated to generate blocks-manifest.php safely.',
        ));
      }
      touchedFiles.push(await makeModifiedFile(profile.root, profile.packageFile, updatedPackage));
      notes.push('The existing build script gains --blocks-manifest so the collection includes the new build directory.');
    }
    const metadataCollection = {
      directory: path.join(profile.root, profile.buildDirectory),
      manifest: path.join(profile.root, profile.buildRoot, 'blocks-manifest.php'),
      key: metadataCollectionKey,
    };
    profile.metadataCollection = metadataCollection;
    notes.push(
      `Metadata collection: ${metadataCollection.manifest} (key ${JSON.stringify(metadataCollectionKey)}, directory ${buildDirectory})`,
    );
  }

  if (block.files['font-licenses.txt'] !== undefined) {
    await addFontLicenseBuildStep(profile.root, `${profile.blockDirectory}/${blockLeaf}`,
      `${profile.buildDirectory}/${blockLeaf}`, blockLeaf, profile.packageFile, touchedFiles);
    notes.push('A reviewed postbuild step retains the bundled font license notice in the runtime build.');
  }

  return finalizePlan({
    mode: 'existing',
    targetDirectory: sourceDirectory,
    block: { name: block.name, directory: sourceDirectory, buildDirectory },
    profile,
    touchedFiles,
    notes,
  });
}

/** Build a complete standalone wp-scripts plugin plan. No files are created until writePluginOutput. */
export async function planStandalonePluginOutput(
  outputDirectory: string,
  generated: GeneratedBlockPackage,
): Promise<PluginOutputPlan> {
  const root = path.resolve(outputDirectory);
  const block = normalizeGeneratedBlock(generated);
  const pluginSlug = pluginDirectoryName(block.name);
  const blockLeaf = blockDirectoryName(block.name);
  const sourceDirectory = path.join(root, 'src', 'blocks', blockLeaf);
  const buildDirectory = path.join(root, 'build', 'blocks', blockLeaf);
  const textDomain = pluginSlug;
  const displayName = titleFromSlug(pluginSlug);
  const touchedFiles: PluginTouchedFile[] = [];

  const files: Record<string, string> = {
    'package.json': standalonePackageJson(pluginSlug),
    'package-lock.json': standalonePackageLock(pluginSlug),
    'plugin.php': standaloneBootstrap({ pluginSlug, displayName, textDomain, blockName: block.name, blockLeaf }),
    'readme.txt': standaloneReadme(displayName, pluginSlug),
    '.distignore': standaloneDistIgnore(),
    'scripts/verify-zip.mjs': standaloneZipVerifier(
      pluginSlug,
      blockLeaf,
      [...runtimeFilesFromBlockMetadata(toBuffer(block.files['block.json']!)),
        ...(block.files['font-licenses.txt'] === undefined ? [] : ['font-licenses.txt'])],
    ),
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    touchedFiles.push(await makeTouchedFile(root, target, relativePath, content));
  }
  for (const [relativePath, content] of Object.entries(block.files).sort(([left], [right]) => left.localeCompare(right))) {
    const target = path.join(sourceDirectory, ...relativePath.split('/'));
    touchedFiles.push(await makeTouchedFile(root, target, `src/blocks/${blockLeaf}/${relativePath}`, content));
  }
  if (block.files['font-licenses.txt'] !== undefined) {
    await addFontLicenseBuildStep(root, `src/blocks/${blockLeaf}`, `build/blocks/${blockLeaf}`,
      blockLeaf, path.join(root, 'package.json'), touchedFiles);
  }

  return finalizePlan({
    mode: 'standalone',
    targetDirectory: root,
    block: { name: block.name, directory: sourceDirectory, buildDirectory },
    touchedFiles,
    notes: [
      `Standalone plugin target: ${root}`,
      `Block source target: ${sourceDirectory}`,
      `Build target after npm run build: ${buildDirectory}`,
      `The release ZIP is ${pluginSlug}.zip and is checked by npm run test:zip.`,
      `ZIP policy excludes source, dependencies, VCS files, local environment files, logs, and nested archives.`,
    ],
  });
}

/**
 * Materialize a previously previewed plan. Existing files are never replaced unless their exact
 * preview paths appear in authorizedReplacements. The complete output is first built in a
 * private sibling staging directory. File renames are individually atomic only when the staging
 * and destination reside on the same filesystem; this function intentionally makes no stronger
 * cross-file atomicity claim.
 */
export async function writePluginOutput(
  plan: PluginOutputPlan,
  options: WritePluginOutputOptions = {},
): Promise<WritePluginOutputResult> {
  const root = path.resolve(plan.mode === 'standalone' ? plan.targetDirectory : plan.profile!.root);
  const approved = new Set(options.authorizedReplacements ?? []);
  if (fingerprintPlan(plan) !== plan.fingerprint) {
    throw new Error('Plugin output plan changed after preview; create and approve a new preview before writing.');
  }

  // This complete inspection happens before staging or destination mutation. The identical
  // checks run again immediately before every rename because another process may race the
  // preview or staging work.
  const inspected = await inspectPluginPublication(root, plan.touchedFiles, approved);
  const stageDirectory = publicationStageDirectory(root);
  const stageRoot = path.join(stageDirectory, 'output');
  let staged: StagedPluginPublicationFile[] = [];
  let recordPath: string | undefined;
  let publicationStarted = false;
  let publicationComplete = false;
  let publishedSteps = 0;
  const completed = new Set<string>();
  try {
    await mkdir(stageRoot, { recursive: true, mode: 0o700 });
    staged = await stagePluginPublication(root, stageRoot, inspected);
    if (plan.mode === 'standalone') {
      // Resolve the generated lock before publication. A resolution failure therefore leaves all
      // destination files untouched; the final lock bytes are also included in the inventory.
      await writeStandaloneDependencyLock(stageRoot);
      await refreshStagedStandaloneLock(staged);
    }

    const record = storedPublicationRecord(root, plan.fingerprint, staged, completed);
    recordPath = path.join(stageDirectory, 'recovery.json');
    await persistPublicationRecord(recordPath, record);

    for (const item of staged) {
      await recheckPluginPublicationTarget(root, item, approved);
      await mkdir(path.dirname(item.target), { recursive: true });
      // mkdir can race with an attacker replacing a newly made parent. Recheck after it too.
      await recheckPluginPublicationTarget(root, item, approved);
      publicationStarted = true;
      await publishStagedPluginFile(item);
      if (item.operation === 'modify') {
        // rename(2) preserves the temporary file's mode. Keep the previewed target mode explicit
        // in case a platform's creation mask changed it while the temporary file was written.
        await chmod(item.target, item.mode);
      }
      completed.add(item.target);
      publishedSteps += 1;
      record.completed = [...completed].sort();
      await persistPublicationRecord(recordPath, record);
      const recovery = publicationRecovery(root, staged, completed, recordPath);
      if (options.failAfterPublishStep === publishedSteps) {
        throw new Error(`Injected failure after plugin publication step ${publishedSteps}.`);
      }
      await options.onPublished?.(publicationEntry(item), recovery);
    }

    await verifyPublishedPluginTargets(staged, completed, options);
    publicationComplete = true;
    return { directory: root, written: [...completed].sort(), fingerprint: plan.fingerprint };
  } catch (error) {
    if (!publicationStarted) {
      // The validation/staging phase does not publish destination files. Its private temporary
      // directory is safe to discard and is deliberately not represented as destination output.
      await removePublicationStage(stageDirectory);
      throw error;
    }
    const recovery = publicationRecovery(root, staged, await observedCompleted(staged), recordPath);
    if (recordPath) {
      try {
        await persistPublicationRecord(recordPath, storedPublicationRecord(root, plan.fingerprint, staged,
          new Set(recovery.completed.map((entry) => entry.path))));
      } catch {
        // Preserve the original publication error and the in-memory recovery report even if a
        // second storage failure prevents refreshing the on-disk journal.
      }
    }
    if (error instanceof PublicationConflictError) throw error;
    throw new PublicationInterruptedError(
      `Plugin publication was interrupted. Recovery inventory retained${recordPath ? ` at ${recordPath}` : ''}.`,
      recovery,
      { cause: error },
    );
  } finally {
    if (publicationComplete) {
      // Cleanup happens only after every target has been revalidated and success is committed.
      // A failed recursive delete must not turn a completed publication into an interruption
      // whose recovery journal may already have been partially removed.
      await cleanupCompletedPluginStage(stageDirectory);
    }
  }
}

/**
 * Finish an interrupted publication from its retained inventory. Files already published must
 * still have their recorded after-hash; pending files must still be absent (creates) or retain
 * their recorded before-hash (replacements). No changed or unrelated file is overwritten.
 */
export async function retryPluginPublication(
  recovery: PublicationRecovery | string,
  options: Omit<WritePluginOutputOptions, 'authorizedReplacements'> = {},
): Promise<WritePluginOutputResult> {
  const recordPath = typeof recovery === 'string' ? recovery : recovery.recordPath;
  if (!recordPath) throw new Error('A retained plugin recovery record path is required to retry publication.');
  const record = await readStoredPublicationRecord(recordPath);
  const root = record.directory;
  assertPublicationRecordLocation(root, recordPath);
  const completedAtInterruption = new Set(record.completed);
  const retryStageDirectory = publicationStageDirectory(root);
  let staged: StagedPluginPublicationFile[] = [];
  let completed = new Set<string>();
  let publicationStarted = false;
  let publicationComplete = false;
  let publishedSteps = 0;
  try {
    staged = await stageStoredPluginPublication(record, path.join(retryStageDirectory, 'output'));
    completed = await confirmRetryPreconditions(root, staged, completedAtInterruption);
    for (const item of staged) {
      if (completed.has(item.target)) continue;
      await recheckStoredPublicationTarget(root, item);
      await mkdir(path.dirname(item.target), { recursive: true });
      await recheckStoredPublicationTarget(root, item);
      publicationStarted = true;
      await publishStagedPluginFile(item);
      if (item.operation === 'modify') await chmod(item.target, item.mode);
      completed.add(item.target);
      publishedSteps += 1;
      record.completed = [...completed].sort();
      await persistPublicationRecord(recordPath, record);
      const currentRecovery = publicationRecovery(root, staged, completed, recordPath);
      if (options.failAfterPublishStep === publishedSteps) {
        throw new Error(`Injected failure after plugin publication step ${publishedSteps}.`);
      }
      await options.onPublished?.(publicationEntry(item), currentRecovery);
    }
    await verifyPublishedPluginTargets(staged, completed, options);
    publicationComplete = true;
    return { directory: root, written: [...completed].sort(), fingerprint: record.fingerprint };
  } catch (error) {
    if (!publicationStarted) {
      await removePublicationStage(retryStageDirectory);
      throw error;
    }
    const currentCompleted = await observedCompleted(staged);
    try {
      record.completed = [...currentCompleted].sort();
      await persistPublicationRecord(recordPath, record);
    } catch {
      // The original recovery journal remains better than replacing the publication failure.
    }
    if (error instanceof PublicationConflictError) throw error;
    throw new PublicationInterruptedError(
      `Plugin publication retry was interrupted. Recovery inventory retained at ${recordPath}.`,
      publicationRecovery(root, staged, currentCompleted, recordPath),
      { cause: error },
    );
  } finally {
    if (publicationComplete) {
      // Keep the original journal until the retry staging directory is gone. Both cleanup steps
      // are post-success housekeeping, so an I/O failure leaves a harmless recovery record
      // instead of reporting an unrecoverable interruption.
      await cleanupCompletedPluginRetry(retryStageDirectory, recordPath);
    }
  }
}

/** Alias for callers that describe completion as recovery rather than retry. */
export const recoverPluginPublication = retryPluginPublication;

interface InspectedPluginPublicationFile {
  file: PluginTouchedFile;
  target: string;
  relativePath: string;
  mode: number;
  beforeContent?: Buffer;
}

interface StagedPluginPublicationFile {
  target: string;
  relativePath: string;
  operation: PluginFileOperation;
  requiresSeparateAuthorization: boolean;
  mode: number;
  beforeContent?: Buffer;
  beforeHash?: string;
  content: Buffer;
  afterHash: string;
  temporary: string;
}

interface StoredPluginPublicationFile {
  path: string;
  relativePath: string;
  operation: PluginFileOperation;
  mode: number;
  beforeHash?: string;
  beforeContent?: string;
  afterHash: string;
  afterContent: string;
}

interface StoredPluginPublicationRecord {
  version: 1;
  directory: string;
  fingerprint: string;
  files: StoredPluginPublicationFile[];
  completed: string[];
}

/** Validate every target before any staging directory is created. */
async function inspectPluginPublication(
  root: string,
  files: readonly PluginTouchedFile[],
  approved: ReadonlySet<string>,
): Promise<InspectedPluginPublicationFile[]> {
  await assertPluginPublicationRoot(root);
  const inspected: InspectedPluginPublicationFile[] = [];
  for (const file of files) {
    assertTargetInside(root, file.path);
    await assertNoSymlinkedParents(root, file.path);
    const stats = await lstatMaybe(file.path);
    const relativePath = relativePublicationPath(root, file.path);
    if (file.operation === 'create') {
      if (stats) {
        throw new Error(`Refusing to replace existing file without a separately authorized preview: ${file.path}`);
      }
      inspected.push({ file, target: file.path, relativePath, mode: 0o644 });
      continue;
    }
    if (!stats?.isFile()) {
      throw new Error(`Previewed file is no longer a regular file: ${file.path}`);
    }
    if (!file.requiresSeparateAuthorization || !approved.has(file.path)) {
      throw new Error(`Separate explicit authorization is required to replace: ${file.path}`);
    }
    const current = await readFile(file.path);
    if (!file.previousContent || !current.equals(file.previousContent)) {
      throw new Error(`Previewed file changed after inspection: ${file.path}`);
    }
    inspected.push({
      file,
      target: file.path,
      relativePath,
      mode: stats.mode & 0o777,
      beforeContent: Buffer.from(file.previousContent),
    });
  }
  return inspected;
}

/** Build every output byte in the private sibling directory before publishing any destination file. */
async function stagePluginPublication(
  root: string,
  stageRoot: string,
  inspected: readonly InspectedPluginPublicationFile[],
): Promise<StagedPluginPublicationFile[]> {
  const staged: StagedPluginPublicationFile[] = [];
  for (const item of inspected) {
    const temporary = stagePath(stageRoot, item.relativePath);
    await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 });
    const content = Buffer.from(item.file.content);
    await writeFile(temporary, content, { flag: 'wx', mode: item.mode });
    if (item.file.operation === 'modify') await chmod(temporary, item.mode);
    staged.push({
      target: item.target,
      relativePath: item.relativePath,
      operation: item.file.operation,
      requiresSeparateAuthorization: item.file.requiresSeparateAuthorization,
      mode: item.mode,
      beforeContent: item.beforeContent,
      beforeHash: item.beforeContent && publicationHash(item.beforeContent),
      content,
      afterHash: publicationHash(content),
      temporary,
    });
  }
  return staged;
}

/** The lock resolver writes the staged lock, so the published inventory reflects its final bytes. */
async function refreshStagedStandaloneLock(staged: StagedPluginPublicationFile[]): Promise<void> {
  const lock = staged.find((item) => item.relativePath === 'package-lock.json');
  if (!lock) throw new Error('Standalone plugin staging did not include package-lock.json.');
  lock.content = await readFile(lock.temporary);
  lock.afterHash = publicationHash(lock.content);
}

async function recheckPluginPublicationTarget(
  root: string,
  item: StagedPluginPublicationFile,
  approved: ReadonlySet<string>,
): Promise<void> {
  await assertPluginPublicationRoot(root);
  assertTargetInside(root, item.target);
  await assertNoSymlinkedParents(root, item.target);
  const stats = await lstatMaybe(item.target);
  if (item.operation === 'create') {
    if (stats) throw new Error(`Refusing to replace newly appeared file: ${item.target}`);
    return;
  }
  if (!stats?.isFile()) throw new Error(`Previewed file is no longer a regular file: ${item.target}`);
  if (!item.requiresSeparateAuthorization || !approved.has(item.target)) {
    throw new Error(`Separate explicit authorization is required to replace: ${item.target}`);
  }
  const current = await readFile(item.target);
  if (!item.beforeContent || !current.equals(item.beforeContent)) {
    throw new Error(`Previewed file changed before replacement: ${item.target}`);
  }
}

function publicationStageDirectory(root: string): string {
  return path.join(path.dirname(root), `.${path.basename(root)}.block-runner-publication-${randomUUID()}`);
}

function relativePublicationPath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative === '.' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Plugin target resolves outside its approved directory: ${target}`);
  }
  return relative;
}

function stagePath(stageRoot: string, relativePath: string): string {
  return path.join(stageRoot, ...relativePath.split(path.sep));
}

function publicationHash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function publicationEntry(item: StagedPluginPublicationFile): PublicationRecoveryEntry {
  return {
    path: item.target,
    ...(item.beforeHash ? { beforeHash: item.beforeHash, beforeContent: Buffer.from(item.beforeContent!) } : {}),
    afterHash: item.afterHash,
  };
}

function publicationRecovery(
  root: string,
  staged: readonly StagedPluginPublicationFile[],
  completed: ReadonlySet<string>,
  recordPath?: string,
): PublicationRecovery {
  const complete = staged.filter((item) => completed.has(item.target)).map(publicationEntry);
  return {
    directory: root,
    completed: complete,
    pending: staged.filter((item) => !completed.has(item.target)).map(publicationEntry),
    replacements: staged.filter((item) => item.operation === 'modify' && completed.has(item.target)).map(publicationEntry),
    ...(recordPath ? { recordPath } : {}),
  };
}

function storedPublicationRecord(
  root: string,
  fingerprint: string,
  staged: readonly StagedPluginPublicationFile[],
  completed: ReadonlySet<string>,
): StoredPluginPublicationRecord {
  return {
    version: 1,
    directory: root,
    fingerprint,
    files: staged.map((item) => ({
      path: item.target,
      relativePath: item.relativePath,
      operation: item.operation,
      mode: item.mode,
      ...(item.beforeHash ? {
        beforeHash: item.beforeHash,
        beforeContent: item.beforeContent!.toString('base64'),
      } : {}),
      afterHash: item.afterHash,
      afterContent: item.content.toString('base64'),
    })),
    completed: [...completed].sort(),
  };
}

async function persistPublicationRecord(recordPath: string, record: StoredPluginPublicationRecord): Promise<void> {
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, recordPath);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function observedCompleted(staged: readonly StagedPluginPublicationFile[]): Promise<Set<string>> {
  const observed = new Set<string>();
  for (const item of staged) {
    try {
      const beforeRead = await lstatMaybe(item.target);
      if (!beforeRead?.isFile()) continue;
      const content = await readFile(item.target);
      const afterRead = await lstatMaybe(item.target);
      if (afterRead?.isFile() && publicationHash(content) === item.afterHash) observed.add(item.target);
    } catch {
      // The saved completion state remains the best report if the filesystem cannot be read.
    }
  }
  return observed;
}

async function verifyPublishedPluginTargets(
  staged: readonly StagedPluginPublicationFile[],
  completed: ReadonlySet<string>,
  options: Pick<WritePluginOutputOptions, 'onFinalValidationTarget'>,
): Promise<void> {
  const validated: PublicationRecoveryEntry[] = [];
  const observed = new Map<string, PluginFileIdentity>();
  for (const item of staged) {
    if (!completed.has(item.target)) {
      throw new PublicationConflictError(`plugin publication conflict: target was not recorded as completed: ${item.target}`);
    }
    observed.set(item.target, await assertPublishedPluginTarget(item));
    validated.push(publicationEntry(item));
    await options.onFinalValidationTarget?.(publicationEntry(item), validated);
  }
  // Recheck exact identities after every target's content has been read. This catches an
  // earlier target replaced while a later target was being validated. The guarantee ends at
  // this final observation and makes no perpetual or cross-filesystem atomicity claim.
  for (const item of staged) {
    if (!samePluginFileIdentity(observed.get(item.target)!, await pluginRegularFileIdentity(item.target))) {
      throw new PublicationConflictError(`plugin publication conflict: completed target changed: ${item.target}`);
    }
  }
}

interface PluginFileIdentity {
  dev: string;
  ino: string;
  mode: number;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

async function assertPublishedPluginTarget(item: StagedPluginPublicationFile): Promise<PluginFileIdentity> {
  try {
    const { content, identity } = await readStablePluginFile(item.target);
    if (publicationHash(content) !== item.afterHash) {
      throw new PublicationConflictError(`plugin publication conflict: completed target changed: ${item.target}`);
    }
    return identity;
  } catch (error) {
    if (error instanceof PublicationConflictError) throw error;
    throw new PublicationConflictError(`plugin publication conflict: completed target changed: ${item.target}`);
  }
}

async function readStablePluginFile(target: string): Promise<{ content: Buffer; identity: PluginFileIdentity }> {
  const beforeRead = await pluginRegularFileIdentity(target);
  const content = await readFile(target);
  const afterRead = await pluginRegularFileIdentity(target);
  if (!samePluginFileIdentity(beforeRead, afterRead)) {
    throw new Error(`plugin target changed while reading: ${target}`);
  }
  return { content, identity: afterRead };
}

async function pluginRegularFileIdentity(target: string): Promise<PluginFileIdentity> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`plugin target is no longer a regular file: ${target}`);
  }
  const withNs = stats as typeof stats & { mtimeNs?: bigint; ctimeNs?: bigint };
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: Number(stats.mode),
    size: String(stats.size),
    mtimeNs: String(withNs.mtimeNs ?? BigInt(Math.round(Number(stats.mtimeMs) * 1_000_000))),
    ctimeNs: String(withNs.ctimeNs ?? BigInt(Math.round(Number(stats.ctimeMs) * 1_000_000))),
  };
}

function samePluginFileIdentity(left: PluginFileIdentity, right: PluginFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function removePublicationStage(stageDirectory: string): Promise<void> {
  try {
    await rm(stageDirectory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function cleanupCompletedPluginStage(stageDirectory: string): Promise<void> {
  try {
    await removePublicationStage(stageDirectory);
  } catch {
    // Completion has already been established. Keeping private staging is safer than reporting
    // a failed publication after its recovery journal may have been partly removed.
  }
}

async function cleanupCompletedPluginRetry(retryStageDirectory: string, recordPath: string): Promise<void> {
  try {
    await removePublicationStage(retryStageDirectory);
  } catch {
    // Retain the original journal if retry-stage cleanup cannot be completed.
    return;
  }
  await cleanupCompletedPluginStage(path.dirname(recordPath));
}

async function assertPluginPublicationRoot(root: string): Promise<void> {
  const stats = await lstatMaybe(root);
  if (!stats) return;
  if (stats.isSymbolicLink()) throw new Error(`Plugin target root is a symbolic link: ${root}`);
  if (!stats.isDirectory()) throw new Error(`Plugin target root is not a directory: ${root}`);
}

/** Recovery cleanup is limited to the private sibling directory we created for this publication. */
function assertPublicationRecordLocation(root: string, recordPath: string): void {
  const resolvedRecord = path.resolve(recordPath);
  const directory = path.dirname(resolvedRecord);
  const expectedParent = path.dirname(path.resolve(root));
  const expectedPrefix = `.${path.basename(root)}.block-runner-publication-`;
  if (path.basename(resolvedRecord) !== 'recovery.json' || path.dirname(directory) !== expectedParent
    || !path.basename(directory).startsWith(expectedPrefix)) {
    throw new Error(`Plugin publication recovery record is outside its private staging directory: ${recordPath}`);
  }
}

async function readStoredPublicationRecord(recordPath: string): Promise<StoredPluginPublicationRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(recordPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read plugin publication recovery record ${recordPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`Plugin publication recovery record is invalid: ${recordPath}`);
  const record = parsed as Partial<StoredPluginPublicationRecord>;
  if (record.version !== 1 || typeof record.directory !== 'string' || typeof record.fingerprint !== 'string'
    || !Array.isArray(record.files) || !Array.isArray(record.completed)) {
    throw new Error(`Plugin publication recovery record is invalid: ${recordPath}`);
  }
  for (const file of record.files) {
    if (!file || typeof file.path !== 'string' || typeof file.relativePath !== 'string'
      || (file.operation !== 'create' && file.operation !== 'modify') || typeof file.mode !== 'number'
      || typeof file.afterHash !== 'string' || typeof file.afterContent !== 'string'
      || (file.operation === 'modify' && (typeof file.beforeHash !== 'string' || typeof file.beforeContent !== 'string'))) {
      throw new Error(`Plugin publication recovery record is invalid: ${recordPath}`);
    }
  }
  return record as StoredPluginPublicationRecord;
}

async function stageStoredPluginPublication(
  record: StoredPluginPublicationRecord,
  stageRoot: string,
): Promise<StagedPluginPublicationFile[]> {
  await mkdir(stageRoot, { recursive: true, mode: 0o700 });
  const staged: StagedPluginPublicationFile[] = [];
  for (const file of record.files) {
    assertTargetInside(record.directory, file.path);
    const relativePath = relativePublicationPath(record.directory, file.path);
    if (relativePath !== file.relativePath) throw new Error(`Plugin publication recovery record has an invalid target: ${file.path}`);
    const content = Buffer.from(file.afterContent, 'base64');
    if (publicationHash(content) !== file.afterHash) throw new Error(`Plugin publication recovery record has corrupt staged bytes: ${file.path}`);
    const beforeContent = file.beforeContent === undefined ? undefined : Buffer.from(file.beforeContent, 'base64');
    if (beforeContent && publicationHash(beforeContent) !== file.beforeHash) {
      throw new Error(`Plugin publication recovery record has corrupt prior bytes: ${file.path}`);
    }
    const temporary = stagePath(stageRoot, relativePath);
    await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 });
    await writeFile(temporary, content, { flag: 'wx', mode: file.mode });
    if (file.operation === 'modify') await chmod(temporary, file.mode);
    staged.push({
      target: file.path,
      relativePath,
      operation: file.operation,
      requiresSeparateAuthorization: file.operation === 'modify',
      mode: file.mode,
      beforeContent,
      beforeHash: file.beforeHash,
      content,
      afterHash: file.afterHash,
      temporary,
    });
  }
  return staged;
}

async function confirmRetryPreconditions(
  root: string,
  staged: readonly StagedPluginPublicationFile[],
  completedAtInterruption: ReadonlySet<string>,
): Promise<Set<string>> {
  await assertPluginPublicationRoot(root);
  const completed = new Set<string>();
  for (const item of staged) {
    assertTargetInside(root, item.target);
    await assertNoSymlinkedParents(root, item.target);
    const stats = await lstatMaybe(item.target);
    const current = stats?.isFile() ? await readFile(item.target) : undefined;
    if (current && publicationHash(current) === item.afterHash) {
      completed.add(item.target);
      continue;
    }
    if (completedAtInterruption.has(item.target)) {
      throw new Error(`Refusing recovery because a previously published file changed: ${item.target}`);
    }
    if (item.operation === 'create') {
      if (stats) throw new Error(`Refusing recovery because a pending target appeared: ${item.target}`);
      continue;
    }
    if (!stats?.isFile() || !item.beforeContent || !current?.equals(item.beforeContent)) {
      throw new Error(`Refusing recovery because a pending replacement changed: ${item.target}`);
    }
  }
  return completed;
}

async function recheckStoredPublicationTarget(root: string, item: StagedPluginPublicationFile): Promise<void> {
  await assertPluginPublicationRoot(root);
  assertTargetInside(root, item.target);
  await assertNoSymlinkedParents(root, item.target);
  const stats = await lstatMaybe(item.target);
  if (item.operation === 'create') {
    if (stats) throw new Error(`Refusing recovery because a pending target appeared: ${item.target}`);
    return;
  }
  if (!stats?.isFile() || !item.beforeContent) {
    throw new Error(`Refusing recovery because a pending replacement changed: ${item.target}`);
  }
  const current = await readFile(item.target);
  if (!current.equals(item.beforeContent)) {
    throw new Error(`Refusing recovery because a pending replacement changed: ${item.target}`);
  }
}

/**
 * A hard link is an exclusive create: unlike rename it cannot silently replace a file that
 * appears after the final recheck. Replacements retain rename's same-filesystem atomic swap.
 */
async function publishStagedPluginFile(item: StagedPluginPublicationFile): Promise<void> {
  if (item.operation === 'create') {
    await link(item.temporary, item.target);
    await unlink(item.temporary);
    return;
  }
  await rename(item.temporary, item.target);
}

/** A narrow archive policy check for the standalone release lane. */
export function assertStandaloneZipEntries(
  entries: readonly string[],
  blockDirectory: string,
  runtimeFiles: readonly string[] = [],
): void {
  const normalized = stripArchiveRoot(entries);
  const blockRoot = `build/blocks/${blockDirectory}`;
  const required = [
    'plugin.php',
    'readme.txt',
    `${blockRoot}/block.json`,
    ...runtimeFiles.map((file) => `${blockRoot}/${normalizeRuntimeFile(file)}`),
  ];
  for (const file of required) {
    if (!normalized.includes(file)) {
      throw new Error(`Standalone ZIP is missing runtime file: ${file}`);
    }
  }
  const forbidden = /^(?:node_modules|src|scripts|\.git|\.github)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)[^/]*\.(?:log|zip)$/i;
  const accidental = normalized.find((entry) => forbidden.test(entry));
  if (accidental) {
    throw new Error(`Standalone ZIP contains excluded local/private file: ${accidental}`);
  }
  const unexpected = normalized.find((entry) => entry !== 'plugin.php' && entry !== 'readme.txt' && entry !== 'package.json' && !entry.startsWith('build/'));
  if (unexpected) {
    throw new Error(`Standalone ZIP contains a file outside its runtime allowlist: ${unexpected}`);
  }
}

function unsupported(kind: UnsupportedPluginProfile['kind'], root: string, reason: string): UnsupportedPluginProfile {
  return { kind, root, reason, standaloneAvailable: true };
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function asObjectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

interface ParsedWpScriptsBuild {
  sourcePath?: string;
  outputPath?: string;
  blocksManifest: boolean;
}

/**
 * This profile relies on wp-scripts' metadata entry discovery, which is disabled when a build
 * entry is supplied positionally. Parse the small, explicit command shape rather than merely
 * matching its prefix so an arbitrary entry point cannot be mistaken for recursive discovery.
 */
function parseWpScriptsBuild(command: string): ParsedWpScriptsBuild | undefined {
  const argv = shellWords(command);
  if (!argv || argv[0] !== 'wp-scripts' || argv[1] !== 'build') return undefined;

  const parsed: ParsedWpScriptsBuild = { blocksManifest: false };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--blocks-manifest') {
      if (parsed.blocksManifest) return undefined;
      parsed.blocksManifest = true;
      continue;
    }

    const option = argument.match(/^--(source-path|output-path)(?:=(.*))?$/);
    if (!option) return undefined;
    const key = option[1] === 'source-path' ? 'sourcePath' : 'outputPath';
    if (parsed[key] !== undefined) return undefined;

    const value = option[2] === undefined ? argv[++index] : option[2];
    if (!value || value.startsWith('--')) return undefined;
    parsed[key] = value;
  }
  return parsed;
}

/** Split the limited package-script syntax we support, including quoted option values. */
function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let hasWord = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      word += character;
      hasWord = true;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      hasWord = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      hasWord = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      hasWord = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (hasWord) words.push(word);
      word = '';
      hasWord = false;
      continue;
    }
    word += character;
    hasWord = true;
  }
  if (quote || escaped) return undefined;
  if (hasWord) words.push(word);
  return words;
}

function isWpScriptsBuild(command: string): boolean {
  return parseWpScriptsBuild(command) !== undefined;
}

function isSafeRelativeDirectory(value: string): boolean {
  return value !== '.' && !value.includes('\\') && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isSafeRelativeFile(value: string): boolean {
  return isSafeRelativeDirectory(value) || (!value.includes('\\') && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'));
}

function commonDirectory(directories: readonly string[]): string {
  const split = directories.map((directory) => directory === '.' ? [] : directory.split('/'));
  const first = split[0] ?? [];
  const common: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const component = first[index]!;
    if (split.every((parts) => parts[index] === component)) common.push(component);
    else break;
  }
  return common.join('/');
}

function joinPosix(left: string, right: string): string {
  return right ? `${left}/${right}` : left;
}

async function findBlockMetadata(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.isFile() && entry.name === 'block.json') found.push(relative);
    }
  }
  await walk(root);
  return found.sort();
}

/** wp-scripts loads these root files without them appearing in package.json. */
async function findAutomaticWebpackConfig(root: string): Promise<string | undefined> {
  for (const name of ['webpack.config.js', 'webpack.config.babel.js']) {
    if (await lstatMaybe(path.join(root, name))) return name;
  }
  return undefined;
}

async function findPhpFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, relative = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (['node_modules', '.git', 'build', 'src', 'vendor'].includes(entry.name)) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, childRelative);
      else if (entry.isFile() && entry.name.endsWith('.php')) found.push(childRelative);
    }
  }
  await walk(root);
  return found.sort();
}

async function findDirectRegistration(root: string, phpFiles: readonly string[], buildRoot: string): Promise<{ file: string } | undefined> {
  const candidates: string[] = [];
  const escapedBuild = escapeRegex(buildRoot);
  const pattern = new RegExp(`register_block_type\\s*\\(\\s*__DIR__\\s*\\.\\s*(['"])\\/${escapedBuild}(?:\\/[^'"]+)?\\1\\s*\\)`, 'g');
  for (const relative of phpFiles) {
    const file = path.join(root, ...relative.split('/'));
    if (pattern.test((await readFile(file)).toString('utf8'))) candidates.push(file);
    pattern.lastIndex = 0;
  }
  if (candidates.length > 1) return undefined;
  return candidates.length === 1 ? { file: candidates[0]! } : undefined;
}

async function findCollectionRegistration(root: string, phpFiles: readonly string[], buildRoot: string, buildDirectory: string): Promise<{ file: string } | undefined> {
  const candidates: string[] = [];
  for (const relative of phpFiles) {
    const file = path.join(root, ...relative.split('/'));
    const content = (await readFile(file)).toString('utf8');
    if (collectionBootstrapUpdate(content, path.dirname(file), buildRoot, buildDirectory, 'block-runner-discovery') !== undefined) candidates.push(file);
  }
  if (candidates.length > 1) return undefined;
  return candidates.length === 1 ? { file: candidates[0]! } : undefined;
}

function normalizeGeneratedBlock(input: GeneratedBlockPackage): GeneratedBlockPackage {
  if (!input || typeof input.name !== 'string' || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(input.name)) {
    throw new Error('Generated block must have a lowercase namespace/name block name.');
  }
  if (!input.files || typeof input.files !== 'object' || Array.isArray(input.files) || !Object.prototype.hasOwnProperty.call(input.files, 'block.json')) {
    throw new Error('Generated block must include block.json.');
  }
  const files: Record<string, Buffer> = {};
  for (const [file, content] of Object.entries(input.files)) {
    if (!isSafeRelativeFile(file) || (typeof content !== 'string' && !Buffer.isBuffer(content))) {
      throw new Error(`Generated block contains an unsafe file: ${JSON.stringify(file)}`);
    }
    files[file] = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8');
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(files['block.json']!.toString('utf8'));
  } catch {
    throw new Error('Generated block block.json is not valid JSON.');
  }
  if (!metadata || typeof metadata !== 'object' || (metadata as { name?: unknown }).name !== input.name) {
    throw new Error('Generated block block.json name does not match the generated block name.');
  }
  return { name: input.name, files };
}

function blockDirectoryName(blockName: string): string {
  return blockName.split('/')[1]!;
}

function pluginDirectoryName(blockName: string): string {
  return `${blockName.split('/')[0]!}-${blockDirectoryName(blockName)}`;
}

/**
 * WordPress block metadata may name any runtime asset with `file:./…`. Preserve those paths
 * verbatim (apart from removing the harmless leading `./`) so the release test reflects the
 * actual block contract rather than a convention such as `index.js`.
 */
function runtimeFilesFromBlockMetadata(metadataFile: Buffer): string[] {
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataFile.toString('utf8'));
  } catch {
    throw new Error('Generated block block.json is not valid JSON.');
  }
  const files = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('file:')) {
      files.add(normalizeRuntimeFile(value.slice('file:'.length)));
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(metadata);
  return [...files].sort();
}

function normalizeRuntimeFile(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!isSafeRelativeFile(normalized)) {
    throw new Error(`Generated block metadata references an unsafe local file: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function toBuffer(content: PluginFileContent): Buffer {
  return Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8');
}

function stripArchiveRoot(entries: readonly string[]): string[] {
  const normalized = entries
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean);
  if (normalized.includes('plugin.php')) return normalized;

  const rootedPlugin = normalized.find((entry) => /^[^/]+\/plugin\.php$/.test(entry));
  if (!rootedPlugin) return normalized;

  const root = rootedPlugin.slice(0, -'/plugin.php'.length);
  const prefix = `${root}/`;
  const outsideRoot = normalized.find((entry) => !entry.startsWith(prefix));
  if (outsideRoot) {
    throw new Error(`Standalone ZIP contains an entry outside its plugin root: ${outsideRoot}`);
  }
  return normalized.map((entry) => entry.slice(prefix.length));
}

async function makeTouchedFile(root: string, target: string, relativePath: string, content: PluginFileContent): Promise<PluginTouchedFile> {
  assertTargetInside(root, target);
  const rawContent = toBuffer(content);
  const existing = await lstatMaybe(target);
  if (existing) {
    if (!existing.isFile()) throw new Error(`Planned plugin target is not a regular file: ${target}`);
    return {
      path: target,
      relativePath,
      operation: 'modify',
      content: rawContent,
      previousContent: await readFile(target),
      requiresSeparateAuthorization: true,
    };
  }
  return { path: target, relativePath, operation: 'create', content: rawContent, requiresSeparateAuthorization: false };
}

async function makeModifiedFile(root: string, target: string, content: PluginFileContent): Promise<PluginTouchedFile> {
  const file = await makeTouchedFile(root, target, path.relative(root, target).split(path.sep).join('/'), content);
  if (file.operation !== 'modify') throw new Error(`Expected existing bootstrap file is missing: ${target}`);
  return file;
}

function directInsertion(bootstrap: string, buildRoot: string, blockLeaf: string): string | undefined {
  const pathLiteral = `/${buildRoot}/${blockLeaf}`;
  const pattern = new RegExp(`register_block_type\\s*\\(\\s*__DIR__\\s*\\.\\s*(['"])\\/${escapeRegex(buildRoot)}(?:\\/[^'"]+)?\\1\\s*\\)\\s*;?`, 'g');
  const matches = [...bootstrap.matchAll(pattern)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return undefined;
  const lineStart = bootstrap.lastIndexOf('\n', last.index) + 1;
  const indent = bootstrap.slice(lineStart, last.index).match(/^\s*/)?.[0] ?? '';
  const insertion = `${last[0]}\n${indent}register_block_type( __DIR__ . '${pathLiteral}' );`;
  return `${bootstrap.slice(0, last.index)}${insertion}${bootstrap.slice(last.index + last[0].length)}`;
}

function collectionBootstrapUpdate(bootstrap: string, root: string, buildRoot: string, buildDirectory: string, blockLeaf: string): string | undefined {
  // Resolve only literal path concatenations, never execute host PHP. A more
  // dynamic bootstrap is outside this deliberately narrow host profile.
  const variables = new Map<string, string>();
  const resolve = (expression: string): string | undefined => {
    const parts = expression.trim().match(/__DIR__|\$[a-zA-Z_]\w*|'[^']*'|"[^"$]*"|\s+|\./g);
    if (!parts || parts.join('') !== expression.trim()) return undefined;
    const values = parts.filter((part) => part.trim() && part !== '.').map((part) => {
      if (part === '__DIR__') return root;
      if (part.startsWith('$')) return variables.get(part);
      return part.slice(1, -1);
    });
    return values.every((value) => value !== undefined) ? values.join('') : undefined;
  };
  for (const match of bootstrap.matchAll(/(\$[a-zA-Z_]\w*)\s*=\s*([^;]+);/g)) {
    const value = resolve(match[2]!);
    if (value !== undefined && !variables.has(match[1]!)) variables.set(match[1]!, value);
    else variables.delete(match[1]!);
  }
  const directory = path.join(root, buildDirectory);
  const manifest = path.join(root, buildRoot, 'blocks-manifest.php');
  const collections = [...bootstrap.matchAll(/\bwp_register_block_metadata_collection\s*\(\s*([^,]+),\s*([^,)]+)\s*\)\s*;/g)];
  if (collections.length !== 1 || resolve(collections[0]![1]!) !== directory || resolve(collections[0]![2]!) !== manifest) return undefined;
  const bulk = [...bootstrap.matchAll(/\bwp_register_block_types_from_metadata_collection\s*\(\s*([^,)]+)(?:,\s*([^,)]+))?\s*\)\s*;/g)];
  if (bulk.length) {
    return bulk.length === 1 && resolve(bulk[0]![1]!) === directory
      && (!bulk[0]![2] || resolve(bulk[0]![2]!) === manifest) ? bootstrap : undefined;
  }
  // Selective registration uses register_block_type(path); there is no
  // singular register_block_type_from_metadata_collection WordPress API.
  const registrations = [...bootstrap.matchAll(/\bregister_block_type\s*\(\s*([^,)]+)\s*\)\s*;/g)]
    .filter((match) => { const value = resolve(match[1]!); return value && path.dirname(value) === directory; });
  const last = registrations.at(-1);
  if (!last || last.index === undefined) return undefined;
  const lineStart = bootstrap.lastIndexOf('\n', last.index) + 1;
  const indent = bootstrap.slice(lineStart, last.index).match(/^\s*/)?.[0] ?? '';
  const insertion = `${last[0]}\n${indent}register_block_type( ${collections[0]![1]!.trim()} . '/${blockLeaf}' );`;
  return `${bootstrap.slice(0, last.index)}${insertion}${bootstrap.slice(last.index + last[0].length)}`;
}

function hasBlocksManifest(command: string): boolean {
  return /--blocks-manifest(?:\s|$)/.test(command);
}

function appendBlocksManifest(packageText: string): string | undefined {
  // Change precisely the JSON string that backs `scripts.build`; formatting and all unrelated
  // package fields remain byte-for-byte intact.
  const match = packageText.match(/("build"\s*:\s*")((?:\\.|[^"\\])*)(")/);
  if (!match || !isWpScriptsBuild(match[2]!.replace(/\\"/g, '"'))) return undefined;
  const command = match[2]!;
  if (hasBlocksManifest(command)) return packageText;
  return `${packageText.slice(0, match.index!)}${match[1]}${command} --blocks-manifest${match[3]}${packageText.slice(match.index! + match[0].length)}`;
}

function finalizePlan(input: Omit<PluginOutputPlan, 'fingerprint'>): PluginOutputPlan {
  const duplicate = input.touchedFiles.find((file, index, all) => all.findIndex((candidate) => candidate.path === file.path) !== index);
  if (duplicate) throw new Error(`Plugin preview has duplicate target: ${duplicate.path}`);
  const plan = { ...input, touchedFiles: [...input.touchedFiles].sort((left, right) => left.path.localeCompare(right.path)), fingerprint: '' };
  return { ...plan, fingerprint: fingerprintPlan(plan) };
}

function fingerprintPlan(plan: Omit<PluginOutputPlan, 'fingerprint'> | PluginOutputPlan): string {
  const view = {
    mode: plan.mode,
    targetDirectory: plan.targetDirectory,
    block: plan.block,
    profile: plan.profile && {
      root: plan.profile.root,
      sourceRoot: plan.profile.sourceRoot,
      buildRoot: plan.profile.buildRoot,
      registration: plan.profile.registration,
      metadataCollection: plan.profile.metadataCollection,
    },
    touchedFiles: plan.touchedFiles.map((file) => ({
      path: file.path,
      operation: file.operation,
      content: file.content,
      previousContent: file.previousContent,
    })),
  };
  return createHash('sha256').update(JSON.stringify(view)).digest('hex');
}

function assertTargetInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Plugin target resolves outside its approved directory: ${target}`);
  }
}

async function assertNoSymlinkedParents(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(target));
  let current = resolvedRoot;
  const rootStats = await lstatMaybe(current);
  if (rootStats?.isSymbolicLink()) throw new Error(`Plugin target root is a symbolic link: ${root}`);
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const stats = await lstatMaybe(current);
    if (!stats) return;
    if (stats.isSymbolicLink()) throw new Error(`Plugin target parent is a symbolic link: ${current}`);
    if (!stats.isDirectory()) throw new Error(`Plugin target parent is not a directory: ${current}`);
  }
}

async function lstatMaybe(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleFromSlug(slug: string): string {
  return slug.split('-').map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
}

async function writeStandaloneDependencyLock(root: string): Promise<void> {
  try {
    // `--package-lock-only` resolves the exact transitive tree without leaving a node_modules
    // directory in the generated plugin. Its subsequent `npm ci` therefore installs the pinned
    // local wp-scripts binary rather than having a build script download one through npx.
    await execFileAsync('npm', [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ], { cwd: root, env: await npmEnvironmentForGeneratedPlugin(root), timeout: 120_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve the standalone @wordpress/scripts dependency lock: ${detail}`);
  }
}

/** Keep font notices outside minified CSS, in both supported wp-scripts delivery profiles. */
async function addFontLicenseBuildStep(
  root: string, source: string, output: string, leaf: string, packageFile: string,
  touchedFiles: PluginTouchedFile[],
): Promise<void> {
  const scriptRelative = `scripts/block-runner-copy-font-licenses-${leaf}.mjs`;
  const command = `node ${scriptRelative}`;
  const existingIndex = touchedFiles.findIndex((file) => file.path === packageFile);
  const packageText = existingIndex >= 0
    ? touchedFiles[existingIndex]!.content.toString()
    : await readFile(packageFile, 'utf8');
  const pkg = JSON.parse(packageText);
  pkg.scripts ??= {};
  const previous = pkg.scripts.postbuild;
  if (previous !== undefined && typeof previous !== 'string') {
    throw new Error('Existing postbuild must be a string before adding font notice transport.');
  }
  if (previous !== command && !previous?.endsWith(` && ${command}`)) {
    pkg.scripts.postbuild = previous ? `${previous} && ${command}` : command;
  }
  const packageChange = await makeTouchedFile(root, packageFile, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  if (existingIndex >= 0) touchedFiles[existingIndex] = packageChange;
  else touchedFiles.push(packageChange);
  const script = `import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, ${JSON.stringify(source)}, 'font-licenses.txt');
const output = path.join(root, ${JSON.stringify(output)});
await mkdir(output, { recursive: true });
await copyFile(source, path.join(output, 'font-licenses.txt'));
`;
  touchedFiles.push(await makeTouchedFile(root, path.join(root, scriptRelative), scriptRelative, script));
}

function standalonePackageJson(pluginSlug: string): string {
  return `${JSON.stringify({
    name: pluginSlug,
    version: '0.1.0',
    private: true,
    description: 'A WordPress block plugin generated by Block Runner.',
    license: 'GPL-2.0-or-later',
    engines: { node: '>=20' },
    packageManager: 'npm@11.6.2',
    files: ['build', 'plugin.php', 'readme.txt'],
    devDependencies: {
      '@wordpress/scripts': STANDALONE_WP_SCRIPTS_VERSION,
    },
    scripts: {
      build: 'wp-scripts build --source-path=src --output-path=build --blocks-manifest',
      zip: 'npm run build && wp-scripts plugin-zip',
      'test:zip': `node scripts/verify-zip.mjs ${pluginSlug}.zip`,
    },
  }, null, 2)}\n`;
}

function standalonePackageLock(pluginSlug: string): string {
  // This seed is replaced with npm's complete dependency tree by writePluginOutput before the
  // generated project is returned. Keeping it in the preview exposes every file up front.
  return `${JSON.stringify({
    name: pluginSlug,
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: pluginSlug,
        version: '0.1.0',
        license: 'GPL-2.0-or-later',
        engines: { node: '>=20' },
        devDependencies: { '@wordpress/scripts': STANDALONE_WP_SCRIPTS_VERSION },
      },
    },
  }, null, 2)}\n`;
}

function standaloneBootstrap(input: { pluginSlug: string; displayName: string; textDomain: string; blockName: string; blockLeaf: string }): string {
  return `<?php\n/**\n * Plugin Name: ${input.displayName}\n * Description: A registered block generated by Block Runner.\n * Version: 0.1.0\n * Requires at least: 7.1\n * Requires PHP: 7.4\n * Text Domain: ${input.textDomain}\n * License: GPL-2.0-or-later\n */\n\ndefined( 'ABSPATH' ) || exit;\n\nfunction ${input.pluginSlug.replace(/-/g, '_')}_register_blocks() {\n\t$build_dir = __DIR__ . '/build';\n\t$manifest = $build_dir . '/blocks-manifest.php';\n\n\tif ( function_exists( 'wp_register_block_metadata_collection' ) && file_exists( $manifest ) ) {\n\t\twp_register_block_metadata_collection( $build_dir . '/blocks', $manifest );\n\t\twp_register_block_types_from_metadata_collection( $build_dir . '/blocks', $manifest );\n\t\treturn;\n\t}\n\n\tregister_block_type( $build_dir . '/blocks/${input.blockLeaf}' );\n}\nadd_action( 'init', '${input.pluginSlug.replace(/-/g, '_')}_register_blocks' );\n`;
}

function standaloneReadme(displayName: string, pluginSlug: string): string {
  return `=== ${displayName} ===\nContributors: ${pluginSlug}\nTags: block, editor\nRequires at least: 7.1\nTested up to: 7.1\nRequires PHP: 7.4\nStable tag: 0.1.0\nLicense: GPL-2.0-or-later\n\nA standalone registered block plugin generated by Block Runner.\n\n== Build a release ==\n\nRun npm ci, npm run zip, then npm run test:zip. Upload the generated ZIP from a clean checkout.\n`;
}

function standaloneDistIgnore(): string {
  return `node_modules/\nsrc/\nscripts/\n.git/\n.github/\n.env\n.env.*\n*.log\n*.zip\npackage.json\npackage-lock.json\n`;
}

function standaloneZipVerifier(pluginSlug: string, blockLeaf: string, runtimeFiles: readonly string[]): string {
  const runtime = runtimeFiles.map((file) => `build/blocks/${blockLeaf}/${file}`);
  return `import { execFileSync } from 'node:child_process';\n\nconst zip = process.argv[2] || '${pluginSlug}.zip';\nconst initialEntries = execFileSync( 'unzip', [ '-Z1', zip ], { encoding: 'utf8' } )\n\t.split( /\\r?\\n/ )\n\t.filter( Boolean )\n\t.map( ( entry ) => entry.replace( /^\\.\\//, '' ).replace( /\\/$/, '' ) )\n\t.filter( Boolean );\nconst rootedPlugin = initialEntries.find( ( entry ) => /^[^/]+\\/plugin\\.php$/.test( entry ) );\nconst root = rootedPlugin ? rootedPlugin.slice( 0, -'/plugin.php'.length ) : undefined;\nif ( root && initialEntries.some( ( entry ) => ! entry.startsWith( root + '/' ) ) ) {\n\tthrow new Error( 'Release ZIP contains an entry outside its plugin root.' );\n}\nconst entries = root ? initialEntries.map( ( entry ) => entry.slice( root.length + 1 ) ) : initialEntries;\nconst required = ${JSON.stringify(['plugin.php', 'readme.txt', `build/blocks/${blockLeaf}/block.json`, ...runtime])};\nfor ( const entry of required ) {\n\tif ( ! entries.includes( entry ) ) throw new Error( \`Release ZIP is missing runtime file: \${entry}\` );\n}\nconst forbidden = /^(?:node_modules|src|scripts|\\.git|\\.github)(?:\\/|$)|(?:^|\\/)\\.env(?:\\.|$)|(?:^|\\/)[^/]*\\.(?:log|zip)$/i;\nconst accidental = entries.find( ( entry ) => forbidden.test( entry ) );\nif ( accidental ) throw new Error( \`Release ZIP contains excluded local/private file: \${accidental}\` );\nconst unexpected = entries.find( ( entry ) => entry !== 'plugin.php' && entry !== 'readme.txt' && entry !== 'package.json' && ! entry.startsWith( 'build/' ) );\nif ( unexpected ) throw new Error( \`Release ZIP contains a file outside its runtime allowlist: \${unexpected}\` );\nconsole.log( \`ZIP policy passed: \${zip}\` );\n`;
}
