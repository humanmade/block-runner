#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Command, CommanderError, Option } from 'commander';
import fg from 'fast-glob';
import { canonicalize } from './gate/canonicalize.js';
import { validate } from './gate/validate.js';
import { convert } from './convert/assemble.js';
import { author as generateRegisteredBlock } from './author/index.js';
import { realize } from './intent/index.js';
import { loadConfig } from './config/load.js';
import { collectSiteContext } from './context/run.js';
import { installCanonicalSkill, readCanonicalSkillGuide, SkillScope, SkillTarget } from './skill.js';
import {
  detectWpScriptsPlugin,
  planExistingPluginOutput,
  planStandalonePluginOutput,
  UnsupportedPluginLayoutError,
  writePluginOutput,
  type GeneratedBlockPackage,
} from './plugin/profile.js';
import { runProof, type ProofFixture } from './proof/runner.js';
import { isProofProfileName } from './proof/profiles.js';
import { BlockRunnerReport, CommonOptions, HeadlessBootError } from './types.js';
import { hashAuthoringConfirmation, inspectAuthoringDestination, writeAuthoringPlan } from './authoring/destination.js';
import { materializeAuthoringPlan } from './authoring/generate.js';
import { hashAuthoringPlan, serializeAuthoringPlan, validateAuthoringPlan } from './authoring/schema.js';
import { renderAuthoringPreview } from './authoring/preview.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

interface CliOptions extends CommonOptions {
  config?: string;
  json?: boolean;
  out?: string;
  cssOut?: string;
  wpAppPasswordEnv?: string;
  name?: string;
  title?: string;
  category?: string;
  outDir?: string;
}

interface ContextCliOptions {
  wpUrl?: string;
  wpPath?: string;
  ssh?: string;
  wpBinary?: string;
  strict?: boolean;
  out?: string;
}

interface SkillCliOptions {
  install?: boolean;
  dir?: string;
  scope?: SkillScope;
  target?: SkillTarget;
  dryRun?: boolean;
  force?: boolean;
}

interface AuthorPreviewCliOptions {
  json?: boolean;
  outputDir?: string;
  width?: string;
}

interface AuthorWriteCliOptions {
  confirm?: string;
  outputDir?: string;
  json?: boolean;
}

interface PluginInspectCliOptions {
  json?: boolean;
}

interface PluginPreviewCliOptions {
  host?: string;
  standalone?: string;
  json?: boolean;
}

interface PluginWriteCliOptions extends PluginPreviewCliOptions {
  confirm?: string;
  approveReplace?: string[];
}

interface ProofCliOptions {
  profile?: string;
  fixture?: string;
  markup?: string;
  input?: string;
  receiptDir?: string;
  wpEnvConfig?: string;
  run?: boolean;
  keepEnvironment?: boolean;
  json?: boolean;
}

const program = new Command();

program
  .name('block-runner')
  .description('Convert design HTML into valid native Gutenberg block markup.')
  .version(packageVersion)
  .exitOverride();

addTokenOptions(
  addWpCredentialOptions(
    addSharedOptions(program.command('validate <globOrStdin>').description('Validate Gutenberg block markup.'), {
      output: false,
    }),
  ),
)
  .action(async (globOrStdin: string, options: CliOptions) => {
    const apiOptions = normalizeOptions(options);
    const inputs = await readInputs(globOrStdin);
    const reports = await Promise.all(
      inputs.map((input) =>
        validate(input.content, {
          ...apiOptions,
          sourcePath: input.path,
        }),
      ),
    );
    const report = aggregateReports('validate', reports);
    await emit(report, options);
    process.exitCode = report.ok ? 0 : 1;
  });

const author = program.command('author').description('Review and materialize a versioned registered-block authoring plan.');

addTokenOptions(
  addWpCredentialOptions(
    addSharedOptions(program.command('generate-author <htmlOrStdin>', { hidden: true }), {
      output: false,
    }),
  ),
  { styling: false },
)
  .option('--name <namespace/slug>', 'registered block name, for example acme/hero')
  .option('--title <title>', 'block title (defaults from the slug)')
  .option('--category <category>', 'block category (default: widgets)')
  .option('--out-dir <path>', 'write the generated package and copied assets to this directory')
  .action(async (htmlOrStdin: string, options: CliOptions) => {
    if (!htmlOrStdin) {
      program.error('error: author needs exactly one design input');
    }
    if (!options.name) {
      program.error("error: required option '--name <namespace/slug>' not specified");
    }
    const apiOptions = normalizeOptions(options);
    const inputs = await readInputs(htmlOrStdin, { allowInline: true });
    if (inputs.length !== 1) {
      program.error('error: author accepts exactly one design input because it generates exactly one registered block');
    }
    if (!options.outDir && !options.json) {
      program.error('error: author needs --out-dir <path> to write its package, or --json to inspect the generated package');
    }
    const input = inputs[0];
    if (!input) {
      return;
    }
    const report = await generateRegisteredBlock(input.content, {
      ...apiOptions,
      sourcePath: input.path,
      outDir: options.outDir,
      author: {
        name: options.name,
        title: options.title,
        category: options.category,
      },
    });
    await emit(report, options, inputs);
    process.exitCode = report.ok ? 0 : 1;
  });

addTokenOptions(
  addWpCredentialOptions(
    addSharedOptions(program.command('assemble <jsonOrStdin>').description('Assemble an intent tree into native block markup.')),
  ).option('--resolver <kind>', 'media resolver: noop, map, wpcli, rest'),
  { styling: false },
)
  .action(async (jsonOrStdin: string, options: CliOptions) => {
    const apiOptions = normalizeOptions(options);
    const inputs = await readInputs(jsonOrStdin, { allowRawInline: true });
    ensureSingleOutputTarget(inputs, options);
    const reports = await Promise.all(
      inputs.map((input) =>
        realize(input.content, {
          ...apiOptions,
          sourcePath: input.path,
        }),
      ),
    );
    const report = aggregateReports('assemble', reports);
    report.output = reports.map((item) => item.output ?? '').join('\n');
    await emit(report, options, inputs);
    process.exitCode = report.ok ? 0 : 1;
  });

addTokenOptions(
  addWpCredentialOptions(
    addSharedOptions(program.command('fix <globOrStdin>').description('Canonicalize Gutenberg block markup.')),
  ),
)
  .action(async (globOrStdin: string, options: CliOptions) => {
    const apiOptions = normalizeOptions(options);
    const inputs = await readInputs(globOrStdin);
    ensureSingleOutputTarget(inputs, options);
    const reports = await Promise.all(
      inputs.map((input) =>
        canonicalize(input.content, {
          ...apiOptions,
          sourcePath: input.path,
        }),
      ),
    );
    const report = aggregateReports('fix', reports);
    report.output = reports.map((item) => item.output ?? '').join('\n');
    await emit(report, options, inputs);
    process.exitCode = report.ok ? 0 : 1;
  });

addTokenOptions(
  addWpCredentialOptions(
    addSharedOptions(program.command('convert <htmlOrStdin>').description('Convert authored HTML to native block markup.')),
  ).option('--resolver <kind>', 'media resolver: noop, map, wpcli, rest'),
)
  .action(async (htmlOrStdin: string, options: CliOptions) => {
    const apiOptions = normalizeOptions(options);
    // The `open` rung preserves CSS no block attribute can hold by emitting a stylesheet the caller
    // must ship. Without somewhere to put it that CSS is silently lost, so require a sink up front
    // rather than warning after the fact. Checked against the RESOLVED config, not just the flag —
    // `styling: 'open'` in block-runner.config.mjs must not slip past it.
    let resolvedStyling: string | undefined;
    try {
      resolvedStyling = (await loadConfig(apiOptions)).styling;
    } catch (error) {
      // A rejected rung or unreadable config is a usage error: report it as one (exit 1) rather than
      // letting it surface as an unhandled throw.
      program.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (resolvedStyling === 'open' && !options.cssOut && !options.json) {
      program.error(
        'error: --styling open emits sidecar CSS that must go somewhere — pass --css-out <path> to write it, or --json to receive it as sidecarCss',
      );
    }
    const inputs = await readInputs(htmlOrStdin, { allowInline: true });
    ensureSingleOutputTarget(inputs, options);
    const reports = await Promise.all(
      inputs.map((input) =>
        convert(input.content, {
          ...apiOptions,
          sourcePath: input.path,
        }),
      ),
    );
    const report = aggregateReports('convert', reports);
    report.output = reports.map((item) => item.output ?? '').join('\n');
    const fallbackCount = reports
      .flatMap((item) => item.items)
      .filter((item) => /Custom HTML fallback/i.test(item.reason)).length;
    if (fallbackCount > 0) {
      report.hint = `${fallbackCount} block${fallbackCount === 1 ? '' : 's'} fell back to Custom HTML — describing the structure as an intent tree usually converts cleanly: npx block-runner skill`;
    }
    const sidecarCss = reports.map((item) => item.sidecarCss ?? '').filter(Boolean).join('');
    if (sidecarCss) {
      report.sidecarCss = sidecarCss;
    }
    if (options.cssOut) {
      // Written even when empty, so a build step can depend on the file existing.
      await writeFile(options.cssOut, sidecarCss, 'utf8');
    }
    await emit(report, options, inputs);
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command('context')
  .description('Read a WordPress site into a wesper site.context.json manifest (WP-CLI).')
  .option('--wp-url <url>', 'WordPress site URL recorded in the manifest')
  .option('--wp-path <path>', 'WordPress install path for WP-CLI collection')
  .option('--ssh <target>', 'SSH target for remote WP-CLI collection')
  .option('--wp-binary <path>', 'wp-cli binary name or path (default: wp)')
  .option('--strict', 'fail when the collector reports partial data')
  .option('--out <path>', 'write the manifest to a file')
  .action(async (options: ContextCliOptions) => {
    const manifest = await collectSiteContext({
      wpUrl: options.wpUrl,
      wpPath: options.wpPath,
      ssh: options.ssh,
      wpBinary: options.wpBinary,
      strict: options.strict,
    });

    if (options.out) {
      await writeFile(options.out, manifest);
      return;
    }

    process.stdout.write(manifest);
    if (!manifest.endsWith('\n')) {
      process.stdout.write('\n');
    }
  });

const plugin = program
  .command('plugin')
  .description('Inspect or package a generated registered block for a supported wp-scripts plugin.');

plugin
  .command('inspect <hostDirectory>')
  .description('Report a read-only @wordpress/scripts host profile and its registration strategy.')
  .option('--json', 'emit a machine-readable profile')
  .action(async (hostDirectory: string, options: PluginInspectCliOptions) => {
    const profile = await detectWpScriptsPlugin(hostDirectory);
    if (options.json) {
      console.log(JSON.stringify(profile, null, 2));
      process.exitCode = profile.kind === 'recognized' ? 0 : 1;
      return;
    }
    if (profile.kind !== 'recognized') {
      console.error(`plugin inspect: ${profile.reason}`);
      console.error('No files written. Use plugin preview <block-dir> --standalone <output-dir> to create a standalone plugin.');
      process.exitCode = 1;
      return;
    }
    console.log([
      'plugin inspect: recognised',
      `@wordpress/scripts=${profile.wpScriptsVersion}`,
      `source root=${profile.sourceRoot}`,
      `build root=${profile.buildRoot}`,
      `entry discovery=${profile.entryDiscovery}`,
      `registration=${profile.registration} (${profile.registrationFile})`,
    ].join('\n'));
  });

plugin
  .command('preview <blockDirectory>')
  .description('List every generated and bootstrap file that would be touched; writes nothing.')
  .option('--host <directory>', 'recognised existing wp-scripts plugin root')
  .option('--standalone <directory>', 'plan a complete standalone plugin wrapper instead')
  .option('--json', 'emit the machine-readable plan')
  .action(async (blockDirectory: string, options: PluginPreviewCliOptions) => {
    const plan = await pluginPlanForCli(blockDirectory, options);
    emitPluginPlan(plan, options.json ?? false);
  });

plugin
  .command('write <blockDirectory>')
  .description('Write exactly a previewed plugin plan after its fingerprint and replacement approvals are supplied.')
  .requiredOption('--confirm <fingerprint>', 'exact fingerprint printed by plugin preview')
  .option('--host <directory>', 'recognised existing wp-scripts plugin root')
  .option('--standalone <directory>', 'write a complete standalone plugin wrapper instead')
  .option('--approve-replace <path...>', 'absolute preview paths explicitly approved for replacement')
  .option('--json', 'emit a machine-readable write result')
  .action(async (blockDirectory: string, options: PluginWriteCliOptions) => {
    const plan = await pluginPlanForCli(blockDirectory, options);
    if (options.confirm !== plan.fingerprint) {
      throw new Error('plugin confirmation does not match the reviewed preview; no files written');
    }
    const result = await writePluginOutput(plan, { authorizedReplacements: options.approveReplace });
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    console.log(`plugin write: ${result.written.length} file${result.written.length === 1 ? '' : 's'} written to ${result.directory}`);
    for (const file of result.written) console.log(`- ${file}`);
  });

program
  .command('proof <pluginZip>')
  .description('Run a WordPress proof profile and write a content-addressed receipt.')
  .addOption(new Option('--profile <profile>', 'headless, runtime, editor, or full').choices(['headless', 'runtime', 'editor', 'full']).default('full'))
  .option('--fixture <path>', 'JSON fixture with block name, editable fields, and proof assertions')
  .option('--markup <path>', 'generated block markup for the headless validation gate')
  .option('--input <path>', 'reviewed generator input to pin as evidence (required for a passing proof)')
  .option('--receipt-dir <path>', 'directory for immutable evidence and receipts (default: proof-receipts)')
  .option('--wp-env-config <path>', 'wp-env configuration (default: proof/wp-env.json)')
  .option('--no-run', 'only produce a blocked receipt; do not start Docker or Playwright')
  .option('--keep-environment', 'leave wp-env running after the proof')
  .option('--json', 'emit the complete receipt result as JSON')
  .action(async (pluginZip: string, options: ProofCliOptions) => {
    const profile = options.profile ?? 'full';
    if (!isProofProfileName(profile)) {
      program.error(`error: unsupported proof profile ${JSON.stringify(profile)}`);
      return;
    }
    const [fixture, markup, input] = await Promise.all([
      options.fixture ? readJsonFixture(options.fixture) : undefined,
      options.markup ? readFile(options.markup, 'utf8') : undefined,
      options.input ? readFile(options.input) : undefined,
    ]);
    const result = await runProof({
      profile,
      pluginZip,
      fixture,
      markup,
      input,
      inputPath: options.input,
      outputDir: options.receiptDir,
      wpEnvConfig: options.wpEnvConfig,
      execute: options.run,
      keepEnvironment: options.keepEnvironment,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`proof ${result.profile.profile}: ${result.ok ? 'pass' : 'fail'}`);
      console.log(`receipt: ${result.receiptReference.path} (${result.receiptReference.sha256})`);
      for (const failed of result.profile.failedGates) {
        console.log(`- ${failed.gate}: ${failed.status}`);
      }
    }
    process.exitCode = result.ok ? 0 : 1;
  });

program
  .command('skill')
  .description('Print or install the agent guide.')
  .option('--install', 'install the agent skill files')
  .addOption(new Option('--scope <scope>', 'installation scope (default: project)').choices(['project', 'user']))
  .addOption(new Option('--target <target>', 'skill discovery target (default: all)').choices(['all', 'agents', 'claude']))
  .option('--dir <path>', 'install under an explicit skills directory')
  .option('--dry-run', 'show destinations without writing files')
  .option('--force', 'replace locally changed or unmanaged skill files')
  .action(async (options: SkillCliOptions) => {
    if (!options.install) {
      if (options.dir || options.scope || options.target || options.dryRun || options.force) {
        program.error('error: --dir, --scope, --target, --dry-run, and --force require --install');
      }
      process.stdout.write(await readCanonicalSkillGuide());
      return;
    }

    const results = await installCanonicalSkill({
      cwd: process.cwd(),
      home: process.env.HOME || homedir(),
      packageVersion,
      directory: options.dir,
      scope: options.scope,
      target: options.target,
      dryRun: options.dryRun,
      force: options.force,
    });
    for (const result of results) {
      const status = result.dryRun && result.status !== 'unchanged'
        ? `would ${result.status === 'installed' ? 'install' : 'update'}`
        : result.status;
      console.log(`${status} ${result.destination}`);
      for (const warning of result.warnings) {
        console.error(`warning: ${warning}`);
      }
    }
  });

author
  .command('preview <planOrStdin>')
  .description('Validate and render an authoring plan without writing files.')
  .option('--output-dir <dir>', 'exact destination directory to fingerprint (default: plan directory or current directory)')
  .option('--width <columns>', 'preview width in terminal columns')
  .option('--json', 'emit a machine-readable preview')
  .action(async (planOrStdin: string, options: AuthorPreviewCliOptions) => {
    const plan = validateAuthoringPlan(await readAuthoringPlan(planOrStdin));
    const hash = hashAuthoringPlan(plan);
    const destination = authoringDestination(options.outputDir, plan.target.directory);
    const inspection = await inspectAuthoringDestination(destination, plan);
    const confirmation = hashAuthoringConfirmation(plan, inspection);
    const width = parsePreviewWidth(options.width);
    const preview = renderAuthoringPreview(plan, {
      hash,
      confirmationHash: confirmation,
      width,
      // Rendering itself contains no ANSI. Explicitly force the plain policy when NO_COLOR is
      // set so a caller cannot accidentally enable colour through a shared option object later.
      color: !process.env.NO_COLOR,
      destination: inspection.directory,
      destinationFingerprint: inspection.fingerprint,
    });
    const result = {
      ok: true,
      command: 'author preview',
      // `hash` remains the copy-and-paste confirmation value for backwards-compatible CLI use.
      // `planHash` is included separately for consumers that only need plan identity.
      hash: confirmation,
      planHash: hash,
      confirmation,
      canonicalJson: serializeAuthoringPlan(plan),
      plan,
      destination: { directory: inspection.directory, fingerprint: inspection.fingerprint },
      preview,
      noFilesWritten: true,
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    process.stdout.write(preview);
  });

author
  .command('write <planOrStdin>')
  .description('Materialize content already supplied by a confirmed authoring plan.')
  .requiredOption('--confirm <hash>', 'exact destination-bound SHA-256 from author preview')
  .requiredOption('--output-dir <dir>', 'exact destination directory')
  .option('--json', 'emit a machine-readable write result')
  .action(async (planOrStdin: string, options: AuthorWriteCliOptions) => {
    const plan = validateAuthoringPlan(await readAuthoringPlan(planOrStdin));
    const planHash = hashAuthoringPlan(plan);
    if (!options.outputDir) {
      throw new Error('--output-dir is required');
    }
    const destination = authoringDestination(options.outputDir, plan.target.directory);
    const inspection = await inspectAuthoringDestination(destination, plan);
    const confirmation = hashAuthoringConfirmation(plan, inspection);
    // Inspection is read-only. The write boundary receives the same snapshot and checks it again
    // before creating a directory or establishing any new filesystem baseline.
    if (options.confirm !== confirmation) {
      throw new Error('authoring confirmation does not match the reviewed plan and destination; no files written');
    }
    const result = await writeAuthoringPlan(destination, materializeAuthoringPlan(plan), inspection);
    const output = {
      ok: true,
      command: 'author write',
      hash: confirmation,
      planHash,
      destination: { directory: result.directory, fingerprint: result.fingerprint },
      written: result.written,
      noFilesWritten: result.written.length === 0,
    };
    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(`Plan SHA-256: ${planHash}`);
    console.log(`Confirmation SHA-256: ${confirmation}`);
    console.log(`Destination: ${result.directory}`);
    console.log(`Destination fingerprint: ${result.fingerprint}`);
    if (result.written.length === 0) {
      console.log('No files written.');
      return;
    }
    for (const file of result.written) {
      console.log(`Wrote: ${file}`);
    }
  });

async function main(): Promise<void> {
  try {
    routeDirectAuthorInvocation(process.argv);
    rejectAssembleStylingOptions(process.argv);
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? 0 : 2;
      return;
    }

    if (error instanceof HeadlessBootError || (error instanceof Error && error.name === 'HeadlessBootError')) {
      console.error(error.message);
      process.exitCode = 3;
      return;
    }

    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

function routeDirectAuthorInvocation(argv: string[]): void {
  if (argv[2] === 'author' && argv[3] && !['preview', 'write'].includes(argv[3])) {
    argv[2] = 'generate-author';
  }
}

function addSharedOptions(command: Command, options: { output?: boolean } = {}): Command {
  const withCommon = command
    .option('--config <path>', 'path to block-runner config')
    .option('--json', 'emit JSON report')
    .option('--strict', 'fail on strict warnings')
    .option('--explain', 'include converter rule attribution and near-misses');

  return options.output === false
    ? withCommon
    : withCommon.option('--out <path>', 'write converted/fixed markup to a file');
}

function addWpCredentialOptions(command: Command): Command {
  return command
    .option('--wp-url <url>', 'WordPress URL for wpcli/rest resolution')
    .option('--wp-user <user>', 'WordPress username for REST resolution')
    .option('--wp-app-password-env <name>', 'environment variable containing a WordPress application password');
}

function addTokenOptions(command: Command, options: { styling?: boolean } = {}): Command {
  const withTokens = command
    .option('--token-resolver <kind>', 'token resolver: noop, file, wpcli, rest, context')
    .option('--theme-json <path>', 'path to a theme.json for the file token resolver')
    .option('--context <path>', 'path to a wesper site.context.json manifest (token source)')
    .option('--token-match <mode>', 'token match mode: exact, nearest');

  return options.styling === false
    ? withTokens
    : withTokens
        .option('--styling <rung>', 'styling ceiling: strict, relaxed (default), open')
        .option('--css-out <path>', 'write sidecar CSS emitted by --styling open to a file');
}

function normalizeOptions(options: CliOptions): CommonOptions {
  const { config, json, out, wpAppPasswordEnv, name, title, category, outDir, ...rest } = options;
  const wpAppPassword = wpAppPasswordEnv ? process.env[wpAppPasswordEnv] : rest.wpAppPassword;
  return {
    ...rest,
    configPath: config,
    wpAppPassword,
  };
}

async function readInputs(
  target: string,
  options: { allowInline?: boolean; allowRawInline?: boolean } = {},
): Promise<Array<{ path?: string; content: string }>> {
  if (target === '-') {
    return [{ path: '<stdin>', content: await readStdin() }];
  }

  if (existsSync(target)) {
    return [{ path: target, content: await readFile(target, 'utf8') }];
  }

  const files = await fg(target, {
    onlyFiles: true,
    dot: true,
  });

  if (files.length === 0) {
    if (options.allowRawInline) {
      return [{ path: '<inline>', content: target }];
    }
    if (options.allowInline && looksLikeInlineHtml(target)) {
      return [{ path: '<inline>', content: target }];
    }
    throw new Error(`No files matched: ${target}`);
  }

  return Promise.all(files.map(async (file) => ({ path: file, content: await readFile(file, 'utf8') })));
}

/** Read an authoring plan from exactly one safe relative regular file or stdin. */
async function readAuthoringPlan(target: string): Promise<string> {
  if (target === '-') {
    return readStdin();
  }
  if (!isSafePlanPath(target)) {
    throw new Error(`authoring plan path must be a safe relative path: ${JSON.stringify(target)}`);
  }
  let current = path.resolve(process.cwd());
  const segments = target.split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`authoring plan path must not contain a symbolic link: ${target}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`authoring plan path has a non-directory parent: ${target}`);
    }
    if (index === segments.length - 1 && !stats.isFile()) {
      throw new Error(`authoring plan path is not a regular file: ${target}`);
    }
  }
  return readFile(current, 'utf8');
}

function isSafePlanPath(value: string): boolean {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function authoringDestination(outputDirectory: string | undefined, packageDirectory: string | undefined): string {
  // `--output-dir` names the exact package destination, so the directory printed by preview can
  // be passed unchanged to write. A plan directory is only the preview default when no explicit
  // destination was selected.
  if (outputDirectory !== undefined) {
    return path.resolve(outputDirectory);
  }
  return packageDirectory && packageDirectory !== '.'
    ? path.resolve(process.cwd(), ...packageDirectory.split('/'))
    : path.resolve(process.cwd());
}

function parsePreviewWidth(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
    throw new Error('--width must be a positive integer');
  }
  return Number(value);
}

function rejectAssembleStylingOptions(argv: string[]): void {
  const commandIndex = argv.indexOf('assemble');
  if (commandIndex === -1) {
    return;
  }
  const assembleArgs = argv.slice(commandIndex + 1);
  if (assembleArgs.some((arg) => arg === '--styling' || arg.startsWith('--styling='))) {
    program.error(
      'error: --styling does not apply to intent trees because they carry no source CSS; use block-runner convert for authored HTML styling',
    );
  }
  if (assembleArgs.some((arg) => arg === '--css-out' || arg.startsWith('--css-out='))) {
    program.error(
      'error: --css-out does not apply to intent trees because they carry no source CSS; use block-runner convert for authored HTML styling',
    );
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function readJsonFixture(file: string): Promise<ProofFixture> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read proof fixture ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { blockName?: unknown }).blockName !== 'string') {
    throw new Error(`Proof fixture ${file} must be an object with a string blockName`);
  }
  return parsed as ProofFixture;
}

function aggregateReports(command: BlockRunnerReport['command'], reports: BlockRunnerReport[]): BlockRunnerReport {
  return {
    ok: reports.every((report) => report.ok),
    command,
    summary: {
      blocks: reports.reduce((sum, report) => sum + report.summary.blocks, 0),
      valid: reports.reduce((sum, report) => sum + report.summary.valid, 0),
      invalid: reports.reduce((sum, report) => sum + report.summary.invalid, 0),
      warnings: reports.reduce((sum, report) => sum + report.summary.warnings, 0),
    },
    items: reports.flatMap((report) => report.items),
  };
}

async function emit(
  report: BlockRunnerReport,
  options: CliOptions,
  inputs: Array<{ path?: string; content: string }> = [],
): Promise<void> {
  if (report.output && options.out) {
    ensureSafeOutputTarget(report, options, inputs);
    await writeFile(options.out, report.output);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (report.output && !options.out) {
    process.stdout.write(report.output);
    if (!report.output.endsWith('\n')) {
      process.stdout.write('\n');
    }
    emitHint(report);
    return;
  }

  console.log(formatTextReport(report));
  emitHint(report);
}

function emitHint(report: BlockRunnerReport): void {
  if (report.hint) {
    console.error(`hint: ${report.hint}`);
  }
}

function formatTextReport(report: BlockRunnerReport): string {
  const status = report.ok ? 'ok' : 'problems found';
  const lines = [
    `${report.command}: ${status}`,
    `blocks=${report.summary.blocks} valid=${report.summary.valid} invalid=${report.summary.invalid} warnings=${report.summary.warnings}`,
  ];

  for (const item of report.items) {
    const source = item.source
      ? ` (${[item.source.path, item.source.selector, item.source.htmlLine ? `line ${item.source.htmlLine}` : undefined].filter(Boolean).join(' ')})`
      : '';
    lines.push(`- ${item.status}: ${item.block ?? 'input'}: ${item.reason}${source}`);
  }

  return lines.join('\n');
}

function ensureSingleOutputTarget(inputs: Array<{ path?: string; content: string }>, options: CliOptions): void {
  if (inputs.length > 1 && options.out) {
    throw new Error('--out can only be used with a single input file or stdin');
  }
}

function ensureSafeOutputTarget(
  report: BlockRunnerReport,
  options: CliOptions,
  inputs: Array<{ path?: string; content: string }>,
): void {
  if (!options.out) {
    return;
  }

  if (!report.ok) {
    throw new Error('--out is only written when the command succeeds');
  }

  const inputPath = inputs.length === 1 ? inputs[0]?.path : undefined;
  if (inputPath && inputPath !== '<stdin>' && inputPath !== '<inline>' && path.resolve(inputPath) === path.resolve(options.out)) {
    throw new Error('--out must not overwrite the input file');
  }
}

function looksLikeInlineHtml(value: string): boolean {
  return /<([a-z][\w:-]*)(\s|>|\/>)/i.test(value) || /<!--\s+wp:/.test(value);
}

async function pluginPlanForCli(
  blockDirectory: string,
  options: Pick<PluginPreviewCliOptions, 'host' | 'standalone'>,
) {
  if (Boolean(options.host) === Boolean(options.standalone)) {
    throw new Error('Pass exactly one of --host <plugin-root> or --standalone <output-dir>.');
  }
  const generated = await readGeneratedBlockPackage(blockDirectory);
  if (options.standalone) {
    return planStandalonePluginOutput(options.standalone, generated);
  }
  try {
    return await planExistingPluginOutput(options.host!, generated);
  } catch (error) {
    if (error instanceof UnsupportedPluginLayoutError) {
      throw new Error(`${error.message} Offer: plugin preview ${JSON.stringify(blockDirectory)} --standalone <output-dir>.`);
    }
    throw error;
  }
}

function emitPluginPlan(
  plan: Awaited<ReturnType<typeof pluginPlanForCli>>,
  json = false,
): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...plan, noFilesWritten: true }, null, 2));
    return;
  }
  console.log(`plugin preview: ${plan.mode}`);
  console.log(`target directory: ${plan.targetDirectory}`);
  console.log(`confirmation: ${plan.fingerprint}`);
  for (const note of plan.notes) console.log(`- ${note}`);
  console.log('touched files:');
  for (const file of plan.touchedFiles) {
    console.log(`- ${file.operation}${file.requiresSeparateAuthorization ? ' (separate authorization required)' : ''}: ${file.path}`);
  }
  console.log('No files written.');
}

async function readGeneratedBlockPackage(directory: string): Promise<GeneratedBlockPackage> {
  const root = path.resolve(directory);
  const metadataFile = path.join(root, 'block.json');
  if (!existsSync(metadataFile)) {
    throw new Error(`Generated block directory must contain block.json: ${root}`);
  }
  const files: Record<string, Buffer> = {};
  async function walk(current: string, prefix = ''): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Generated block directory must not contain symbolic links: ${path.join(current, entry.name)}`);
      }
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files[relative] = await readFile(absolute);
    }
  }
  await walk(root);
  let metadata: { name?: unknown };
  try {
    metadata = JSON.parse(files['block.json']!.toString('utf8')) as { name?: unknown };
  } catch {
    throw new Error(`Generated block metadata is not valid JSON: ${metadataFile}`);
  }
  if (typeof metadata.name !== 'string') {
    throw new Error(`Generated block metadata has no name: ${metadataFile}`);
  }
  return { name: metadata.name, files };
}

await main();
