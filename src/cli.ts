#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Command, CommanderError } from 'commander';
import fg from 'fast-glob';
import { canonicalize } from './gate/canonicalize.js';
import { validate } from './gate/validate.js';
import { convert } from './convert/assemble.js';
import { BlockRunnerReport, CommonOptions, HeadlessBootError } from './types.js';

interface CliOptions extends CommonOptions {
  config?: string;
  json?: boolean;
  out?: string;
  wpAppPasswordEnv?: string;
}

const program = new Command();

program
  .name('block-runner')
  .description('Convert design HTML into valid native Gutenberg block markup.')
  .version('0.1.0')
  .exitOverride();

addSharedOptions(program.command('validate <globOrStdin>').description('Validate Gutenberg block markup.'), {
  output: false,
})
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

addSharedOptions(program.command('fix <globOrStdin>').description('Canonicalize Gutenberg block markup.'))
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

addSharedOptions(program.command('convert <htmlOrStdin>').description('Convert authored HTML to native block markup.'))
  .option('--resolver <kind>', 'media resolver: noop, map, wpcli, rest')
  .option('--wp-url <url>', 'WordPress URL for wpcli/rest media resolution')
  .option('--wp-user <user>', 'WordPress username for REST media resolution')
  .option('--wp-app-password-env <name>', 'environment variable containing a WordPress application password')
  .action(async (htmlOrStdin: string, options: CliOptions) => {
    const apiOptions = normalizeOptions(options);
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
    await emit(report, options, inputs);
    process.exitCode = report.ok ? 0 : 1;
  });

async function main(): Promise<void> {
  try {
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
  options: { allowInline?: boolean } = {},
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
    if (options.allowInline && looksLikeInlineHtml(target)) {
      return [{ path: '<inline>', content: target }];
    }
    throw new Error(`No files matched: ${target}`);
  }

  return Promise.all(files.map(async (file) => ({ path: file, content: await readFile(file, 'utf8') })));
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
    return;
  }

  console.log(formatTextReport(report));
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
