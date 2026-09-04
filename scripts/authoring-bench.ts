/**
 * Execute the registered-block authoring scorecard against collected receipts.
 *
 * This command does not pretend that unrun WordPress/browser/package gates pass:
 * absent receipts become `blocked`. Use `--json` for a complete machine-readable
 * result or `--receipt <file>` to retain the exact release evidence summary.
 *
 * Examples:
 *   tsx scripts/authoring-bench.ts --json
 *   tsx scripts/authoring-bench.ts --suite benchmarks/authoring --receipt /tmp/authoring-run.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadAuthoringSuite,
  publishedFigureLabel,
  scoreAuthoringSuite,
  type AuthoringRun,
  type RunMetadata,
} from './authoring/score.js';

function valueFor(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function optionalValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function metadata(): RunMetadata {
  return {
    workload: valueFor('--workload') ?? process.env.BLOCK_RUNNER_WORKLOAD,
    model: valueFor('--model') ?? process.env.BLOCK_RUNNER_MODEL ?? 'unreported',
    effort: valueFor('--effort') ?? process.env.BLOCK_RUNNER_EFFORT ?? 'unreported',
    timingMethod: valueFor('--timing-method') ?? process.env.BLOCK_RUNNER_TIMING_METHOD ?? 'receipt wall-clock',
    startedAt: new Date().toISOString(),
  };
}

function terminalFailures(run: AuthoringRun): string[] {
  const failures = run.scores
    .filter((score) => !score.contractPass)
    .map((score) => `${score.id}: ${score.status}${score.failures.length ? ` (${score.failures.join('; ')})` : ''}`);
  if (run.summary.fixtures === 0) failures.unshift('suite: no fixtures were loaded');
  return failures;
}

function printHuman(run: AuthoringRun): void {
  console.log('AUTHORING BENCHMARK — registered blocks (separate from page-block benchmark)');
  console.log(publishedFigureLabel(run));
  console.log(
    `fixtures=${run.summary.fixtures}; scored=${run.summary.scored}; unsupported=${run.summary.unsupported}; ` +
      `blocked=${run.summary.blocked}; engine_error=${run.summary.engineErrors}; ` +
      `contract_pass=${run.summary.contractPass}; dimensions_are_independent=true`,
  );
  for (const score of run.scores) {
    const dimensions = Object.entries(score.dimensions)
      .filter(([, result]) => result.required || result.score !== null)
      .map(([name, result]) => `${name}=${result.score === null ? 'unmeasured' : result.score}`)
      .join(' ');
    console.log(`${score.id}\t${score.status}\t${score.contractPass ? 'pass' : 'fail'}\t${dimensions}`);
    for (const failure of score.failures) console.log(`  ↳ ${failure}`);
  }
  console.log(`hashes=${JSON.stringify(run.hashes)}`);
}

function writeReceipt(run: AuthoringRun, target: string): void {
  const file = path.resolve(target);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
}

function help(): void {
  console.log(`Usage: tsx scripts/authoring-bench.ts [options]

  --suite <directory>       Corpus directory (default: benchmarks/authoring)
  --json                    Print full run JSON instead of the human scorecard
  --receipt <file>          Retain full machine-readable run/receipt JSON
  --model <id>              Label the executing model
  --effort <level>          Label model reasoning effort
  --workload <description>  Label the exact workload
  --timing-method <method>  Label timing methodology

Nonzero exit means a scored check failed, a required gate was blocked, an
unsupported fixture failed open, or a model/tool/engine error invalidated a run.
Expected-negative unsupported fixtures pass only when they fail closed.`);
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    help();
    return;
  }
  const suiteDirectory = path.resolve(valueFor('--suite') ?? 'benchmarks/authoring');
  const suite = loadAuthoringSuite(suiteDirectory);
  const run = scoreAuthoringSuite(suite, suiteDirectory, metadata());
  const receipt = optionalValue('--receipt');
  if (receipt) writeReceipt(run, receipt);
  if (process.argv.includes('--json')) console.log(JSON.stringify(run, null, 2));
  else printHuman(run);

  const failures = terminalFailures(run);
  if (failures.length) {
    if (process.argv.includes('--json')) console.error(JSON.stringify({ releaseGateFailures: failures }, null, 2));
    else console.error(`release gate failed:\n${failures.map((failure) => `  ${failure}`).join('\n')}`);
    process.exitCode = 1;
  }
}

main();
