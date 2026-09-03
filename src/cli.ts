#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Command, CommanderError, Option } from 'commander';
import fg from 'fast-glob';
import { canonicalize } from './gate/canonicalize.js';
import { validate } from './gate/validate.js';
import { convert } from './convert/assemble.js';
import { realize } from './intent/index.js';
import { loadConfig } from './config/load.js';
import { collectSiteContext } from './context/run.js';
import { installCanonicalSkill, readCanonicalSkillGuide, SkillScope, SkillTarget } from './skill.js';
import { runProof, type ProofFixture } from './proof/runner.js';
import { isProofProfileName } from './proof/profiles.js';
import { BlockRunnerReport, CommonOptions, HeadlessBootError } from './types.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

interface CliOptions extends CommonOptions {
  config?: string;
  json?: boolean;
  out?: string;
  cssOut?: string;
  wpAppPasswordEnv?: string;
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

program
  .command('proof <pluginZip>')
  .description('Run a WordPress proof profile and write a content-addressed receipt.')
  .addOption(new Option('--profile <profile>', 'headless, runtime, editor, or full').choices(['headless', 'runtime', 'editor', 'full']).default('full'))
  .option('--fixture <path>', 'JSON fixture with block name, editable fields, and override assertions')
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

async function main(): Promise<void> {
  try {
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
  const { config, json, out, wpAppPasswordEnv, ...rest } = options;
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

await main();
