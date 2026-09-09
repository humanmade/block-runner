#!/usr/bin/env node
/** Install the built tarball as a clean engine-strict consumer, then smoke its CLI and library. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const packDirectory = mkdtempSync(path.join(tmpdir(), 'block-runner-pack-'));
const consumer = mkdtempSync(path.join(tmpdir(), 'block-runner-consumer-'));

try {
  const packed = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], root);
  const details = parsePackJson(packed.stdout);
  if (!Array.isArray(details) || details.length !== 1 || typeof details[0]?.filename !== 'string') {
    throw new Error('npm pack did not return exactly one tarball.');
  }
  const tarball = path.join(packDirectory, details[0].filename);
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');

  run('npm', ['install', '--engine-strict', '--no-audit', '--no-fund', tarball], consumer);
  const cli = path.join(consumer, 'node_modules', 'block-runner', 'dist', 'cli.js');
  const version = run(process.execPath, [cli, '--version'], consumer).stdout.trim();
  const packageVersion = JSON.parse(readFileSync(path.join(consumer, 'node_modules', 'block-runner', 'package.json'), 'utf8')).version;
  if (version !== packageVersion) throw new Error('Packed CLI reported ' + version + '; expected ' + packageVersion + '.');

  const conversion = JSON.parse(run(process.execPath, [cli, 'convert', '<p>Node support smoke</p>', '--json'], consumer).stdout);
  if (!conversion.ok) throw new Error('Packed CLI conversion smoke did not succeed.');

  const guide = readFileSync(path.join(consumer, 'node_modules', 'block-runner', 'skills', 'block-runner', 'references', 'GUIDE.md'), 'utf8');
  const example = guide.match(/<!-- authoring-proposal-example:start -->\s*```js\n([\s\S]*?)\n```\s*<!-- authoring-proposal-example:end -->/);
  if (!example) throw new Error('Packed guide is missing its marked runnable authoring proposal example.');
  const exampleFile = path.join(consumer, 'guide-authoring-proposal.mjs');
  writeFileSync(exampleFile, example[1] + '\n');
  const canonicalPlan = JSON.parse(run(process.execPath, [exampleFile], consumer).stdout);
  const nodes = flatten(canonicalPlan.structure ?? []);
  const grid = nodes.find((node) => node.id === 'grid');
  const image = nodes.find((node) => node.id === 'image');
  if (canonicalPlan.version !== 1 || !canonicalPlan.source || !canonicalPlan.coverage
    || !canonicalPlan.assets?.some((asset) => asset.source === 'https://cdn.example.test/editor.png' && asset.status === 'external')
    || grid?.attributes?.layout?.type !== 'grid'
    || image?.block !== 'core/image' || image.attributes?.caption !== 'Controls remain editable.') {
    throw new Error('Packed guide authoring proposal example did not derive its canonical source, coverage, asset, and native bindings.');
  }

  const publicExample = path.join(consumer, 'node_modules/block-runner/examples/authoring-plan.mjs');
  const examplePlan = JSON.parse(run(process.execPath, [publicExample], consumer).stdout);
  if (examplePlan.target?.name !== 'acme/notice' || !examplePlan.source || !examplePlan.coverage
    || !flatten(examplePlan.structure ?? []).some((node) => node.block === 'core/button' && node.attributes?.url === '/details')) {
    throw new Error('Packed public example did not produce its source-bound canonical plan.');
  }
  writeFileSync(path.join(consumer, 'notice.plan.json'), JSON.stringify(examplePlan));
  const examplePreview = JSON.parse(run(process.execPath, [cli, 'author', 'preview', 'notice.plan.json', '--output-dir', path.join(consumer, 'notice'), '--json'], consumer).stdout);
  if (!examplePreview.noFilesWritten || !examplePreview.confirmation || examplePreview.confirmation === examplePreview.planHash) {
    throw new Error('Packed public example did not reach a destination-bound preview.');
  }

  // Run the documented owner-acceptance preparation through this packed consumer.
  // These explicit proposals exercise the supplied fixtures, not a model benchmark.
  const acceptanceInputs = path.join(consumer, 'acceptance-inputs');
  run(process.execPath, [path.join(root, 'dev/acceptance/0.9-testing/prepare-inputs.mjs'),
    '--output', acceptanceInputs, '--candidate-revision', run('git', ['rev-parse', 'HEAD'], root).stdout.trim()], consumer);
  const acceptanceScript = path.join(consumer, 'author-input.mjs');
  writeFileSync(acceptanceScript, readFileSync(path.join(root, 'dev/acceptance/0.9-testing/author-input.mjs')));
  for (const journey of ['local-asset-feature', 'responsive-panel-grid']) {
    const directory = path.join(consumer, journey);
    mkdirSync(directory);
    const sourceRoot = path.join(acceptanceInputs, journey, 'dev/benchmarks/authoring/sources');
    const report = JSON.parse(run(process.execPath, [acceptanceScript, journey, sourceRoot], directory).stdout);
    const plan = report.package?.canonicalPlan;
    if (!report.ok || !plan) throw new Error(`${journey}: acceptance analysis did not produce a canonical plan.`);
    const source = readFileSync(path.join(sourceRoot, journey === 'local-asset-feature' ? 'semantic/local-assets.html' : 'utility/tailwind-responsive.html'));
    if (plan.source?.sha256 !== createHash('sha256').update(source).digest('hex')) {
      throw new Error(`${journey}: acceptance preparation changed source identity.`);
    }
    writeFileSync(path.join(directory, 'authoring-plan.json'), JSON.stringify(plan));
    const output = path.join(directory, 'generated');
    const preview = JSON.parse(run(process.execPath, [cli, 'author', 'preview', 'authoring-plan.json', '--output-dir', output, '--json'], directory).stdout);
    run(process.execPath, [cli, 'author', 'write', 'authoring-plan.json', '--output-dir', output, '--confirm', preview.confirmation, '--json'], directory);
    if (journey === 'local-asset-feature') {
      const asset = plan.assets.find((entry) => entry.destination?.endsWith('.svg'));
      if (!asset || !readFileSync(path.join(output, asset.destination)).equals(readFileSync(path.join(sourceRoot, 'assets/aurora-dashboard.svg')))
        || !plan.fields.some((entry) => entry.node === 'image' && entry.attribute === 'alt' && entry.mode === 'editable')) {
        throw new Error('Local-asset acceptance lost SVG bytes or editable alternative text.');
      }
    } else {
      const css = readFileSync(path.join(output, 'style.scss'), 'utf8');
      if (!css.includes('grid-column: 1 / -1') || !css.includes('min-width: 640px') || !css.includes('min-width: 1024px')
        || !css.includes('prefers-reduced-motion: reduce') || !css.includes('scroll-behavior: auto !important')
        || !plan.warnings.some((warning) => warning.includes('Component foundation CSS'))) {
        throw new Error('Responsive acceptance lost grid placement, breakpoints, reduced motion, or its containment warning.');
      }
    }
    console.log(`${journey}: packed analysis, preview, and source write passed.`);
  }

  const typecheck = path.join(root, 'node_modules', '.bin', 'tsc');
  writeFileSync(path.join(consumer, 'library-smoke.mts'), [
    "import { AuthoringGenerationError, convert, type ConvertOptions } from 'block-runner';",
    'const convertApi: typeof convert = convert;',
    'let options: ConvertOptions | undefined;',
    'let error: AuthoringGenerationError | undefined;',
    'void convertApi; void options; void error;',
    '',
  ].join('\n'));
  run(typecheck, ['--strict', '--noEmit', '--skipLibCheck', '--typeRoots', path.join(root, 'node_modules', '@types'), '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', 'library-smoke.mts'], consumer);

  run(process.execPath, ['--input-type=module', '--eval', [
    "const api = await import('block-runner');",
    "if (typeof api.convert !== 'function' || typeof api.author !== 'function' || typeof api.collectSourceEvidence !== 'function' || typeof api.AuthoringGenerationError !== 'function') throw new Error('missing public library exports');",
  ].join('\n')], consumer);

  console.log('Packed engine-strict install, CLI, and typed library smoke passed on Node ' + process.versions.node + '.');
} finally {
  trash(packDirectory);
  trash(consumer);
}

function parsePackJson(stdout) {
  const start = stdout.indexOf('[\n');
  if (start < 0) throw new Error('npm pack did not return JSON output:\n' + stdout);
  return JSON.parse(stdout.slice(start));
}

function flatten(nodes) {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function trash(target) {
  // The smoke directories are unique temporary paths, but retain them if this host lacks trash.
  spawnSync('trash', [target], { encoding: 'utf8' });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed with exit ' + result.status + ':\n' + (result.stderr || result.stdout));
  }
  return result;
}
