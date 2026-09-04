import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { executeFixture } from '../scripts/authoring-runner.js';
import {
  AUTHORING_DIMENSIONS, AUTHORING_RUNTIME_ARTIFACTS, authoringHashes, hashFile,
  loadAuthoringSuite, scoreAuthoringFixture, validateAuthoringReceipt,
  type AuthoringReceipt,
} from '../scripts/authoring/score.js';

const suiteDirectory = path.resolve('benchmarks/authoring');
const plan = () => ({
  version: 1, generatorVersion: '0.9.0', target: { name: 'acme/receipt-unit-test', title: 'Receipt unit test' },
  structure: [{ id: 'copy', block: 'core/paragraph', attributes: { content: 'Candidate' } }],
  fields: [], locking: { mode: 'none' }, styles: { strategy: 'native', outcomes: [] },
  pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [],
});

async function setup(negative = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'block-runner-receipt-unit-'));
  const plans = path.join(root, 'plans');
  const run = path.join(root, 'run');
  await mkdir(plans);
  const suite = loadAuthoringSuite(suiteDirectory);
  const fixture = suite.fixtures.find((candidate) => negative ? candidate.expectedStatus === 'unsupported' : candidate.expectedStatus === 'scored')!;
  const hashes = authoringHashes(suite);
  const candidate = plan();
  const input = path.join(plans, `${fixture.id}.json`);
  await writeFile(input, JSON.stringify(candidate));
  const execute = (worker?: string, timeout?: number) => executeFixture(fixture, suiteDirectory, run, worker, hashes, plans, timeout);
  const worker = async (body: string) => {
    const executable = path.join(root, 'worker.mjs');
    await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args=process.argv.slice(2);const arg=(name)=>args[args.indexOf(name)+1];\n${body}\n`);
    await chmod(executable, 0o700);
    return executable;
  };
  return { root, plans, run, input, fixture, candidate, execute, worker };
}

describe('authoring execution receipt boundaries (no model or WordPress calls)', () => {
  it('retains earlier receipts when later saved inputs fail in the CLI loop', async () => {
    const f = await setup();
    // Only the first fixture has a synthetic candidate. The remainder intentionally have no
    // input. This tests batch failure isolation, not product quality or model performance.
    let failed = false;
    try {
      await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/authoring-runner.ts', '--plans', f.plans, '--run-root', f.run], {
        cwd: process.cwd(), env: { ...process.env, BLOCK_RUNNER_AUTHORING_RUNNER: '' },
      });
    } catch (error) {
      failed = true;
      expect(error).toMatchObject({ code: 1 });
    }
    expect(failed).toBe(true);
    const receipts = (await readdir(path.join(f.run, 'receipts'))).filter((file) => file.endsWith('.json'));
    expect(receipts).toHaveLength(loadAuthoringSuite(suiteDirectory).fixtures.length);
    const first = JSON.parse(await readFile(path.join(f.run, 'receipts', `${f.fixture.id}.json`), 'utf8'));
    expect(first.status).toBe('blocked');
    const summary = JSON.parse(await readFile(path.join(f.run, 'authoring-run.json'), 'utf8'));
    expect(summary.summary.scored).toBe(0);
    expect(summary.summary.blocked).toBe(receipts.length);
    expect(summary.summary.engineErrors).toBe(0);
  });

  it('records an absent runtime as blocked with no invented observations', async () => {
    const f = await setup();
    const receipt = f.execute();
    expect(receipt.status).toBe('blocked');
    expect(receipt.environment).toEqual({ wordpress: null, theme: null, browser: null });
    for (const key of Object.keys(AUTHORING_RUNTIME_ARTIFACTS)) expect(receipt.provenance?.[key]).toBeNull();
    expect(validateAuthoringReceipt(f.fixture, receipt, suiteDirectory, path.join(f.run, 'receipts'))).toEqual([]);
    expect(scoreAuthoringFixture(f.fixture, receipt).validMeasurement).toBe(false);
  });

  it('gives the worker candidate-local source and plan snapshots', async () => {
    const f = await setup();
    const worker = await f.worker("fs.writeFileSync('worker-observation.json', JSON.stringify({ source: fs.readFileSync(arg('--source'), 'utf8'), plan: fs.readFileSync(arg('--candidate-plan'), 'utf8'), dependencyArgs: args.filter((value) => value === '--source-dependency').length })); fs.writeFileSync(arg('--result'), JSON.stringify({status:'blocked',artifacts:{observation:{path:'worker-observation.json'}}}));");
    const receipt = f.execute(worker);
    expect(receipt.status).toBe('blocked');
    const observation = JSON.parse(await readFile(path.join(f.run, 'receipts', receipt.artifacts!.observation!.path), 'utf8'));
    expect(observation.source).toContain('hero');
    expect(JSON.parse(observation.plan)).toEqual(f.candidate);
    expect(observation.dependencyArgs).toBe(0);
  });

  it('retains malformed plan input as an engine error without generating source', async () => {
    const f = await setup();
    await writeFile(f.input, '{"broken":');
    const receipt = f.execute();
    expect(receipt).toMatchObject({ status: 'engine_error', error: { kind: 'engine' } });
    expect(existsSync(path.join(f.run, 'candidates', f.fixture.id))).toBe(false);
    expect(await readFile(path.join(f.run, 'receipts', receipt.artifacts!.candidateInput!.path), 'utf8')).toBe('{"broken":');
    expect(validateAuthoringReceipt(f.fixture, receipt, suiteDirectory, path.join(f.run, 'receipts'))).toEqual([]);
  });

  it('counts only a real compiler refusal as the unsupported interaction outcome', async () => {
    const f = await setup(true);
    Object.assign(f.candidate.structure[0]!.attributes, { onClick: 'requesting executable behavior' });
    await writeFile(f.input, JSON.stringify(f.candidate));
    const receipt = f.execute();
    expect(receipt).toMatchObject({ status: 'unsupported', failClosed: { warningCode: 'BR_UNSUPPORTED_INTERACTION', noInteractiveRuntime: true } });
    expect(existsSync(path.join(f.run, 'candidates', f.fixture.id))).toBe(false);
    expect(validateAuthoringReceipt(f.fixture, receipt, suiteDirectory, path.join(f.run, 'receipts'))).toEqual([]);
    expect(scoreAuthoringFixture(f.fixture, receipt)).toMatchObject({ contractPass: true, validMeasurement: false });
  });

  it.each(['exit', 'malformed', 'timeout', 'escaping-artifact', 'linked-artifact', 'reserved-artifact', 'changed-source'])(
    'retains %s worker failures as engine errors, not blocked product results', async (kind) => {
      const f = await setup();
      const body = {
        exit: "console.error('unit test failure'); process.exit(7);",
        malformed: "fs.writeFileSync(arg('--result'), '{broken');",
        timeout: 'setTimeout(() => {}, 10000);',
        'escaping-artifact': "fs.writeFileSync('evidence.txt','test'); fs.writeFileSync(arg('--result'),JSON.stringify({status:'blocked',artifacts:{'../escape':{path:'evidence.txt'}}}));",
        'linked-artifact': "fs.symlinkSync(arg('--source'),'linked.html'); fs.writeFileSync(arg('--result'),JSON.stringify({status:'blocked',artifacts:{source:{path:'linked.html'}}}));",
        'reserved-artifact': "fs.writeFileSync('evidence.txt','test'); fs.writeFileSync(arg('--result'),JSON.stringify({status:'blocked',artifacts:{generatedSourceManifest:{path:'evidence.txt'}}}));",
        'changed-source': "fs.appendFileSync('edit.js','\\n// changed source'); fs.writeFileSync(arg('--result'),JSON.stringify({status:'blocked'}));",
      }[kind]!;
      const receipt = f.execute(await f.worker(body), kind === 'timeout' ? 100 : 10000);
      expect(receipt).toMatchObject({ status: 'engine_error', error: { kind: 'engine' } });
      expect(receipt.artifacts).toHaveProperty('workerStdout');
      expect(receipt.artifacts).toHaveProperty('workerStderr');
      if (kind === 'changed-source') expect(receipt.error?.message).toContain('worker changed generated candidate source: edit.js');
      if (kind === 'reserved-artifact') expect(receipt.error?.message).toContain('cannot replace runner-owned evidence');
      if (kind === 'escaping-artifact') expect(receipt.error?.message).toContain('simple identifier');
      if (kind === 'linked-artifact') expect(receipt.error?.message).toContain('regular file inside');
      expect(validateAuthoringReceipt(f.fixture, receipt, suiteDirectory, path.join(f.run, 'receipts'))).toEqual([]);
      expect(scoreAuthoringFixture(f.fixture, receipt).validMeasurement).toBe(false);
    },
  );

  it('does not manufacture a runtime from a worker that merely echoes requested settings', async () => {
    const f = await setup();
    const receipt = f.execute(await f.worker("fs.writeFileSync('style-ledger.json',JSON.stringify({version:1,entries:[]})); fs.writeFileSync(arg('--result'), JSON.stringify({status:'scored', environment:{wordpress:'7.1',browser:'chromium'}}));"));
    const failures = validateAuthoringReceipt(f.fixture, receipt, suiteDirectory, path.join(f.run, 'receipts'));
    expect(receipt.environment).toEqual({ wordpress: null, theme: null, browser: null });
    expect(failures).toContain('runtime observation requires artifact wordpressInventory');
    expect(failures).toContain('receipt provenance requires hash browserHash');
  });

  it('validates inventory shape and hashes independently from worker pass claims', async () => {
    const f = await setup();
    const receipt: AuthoringReceipt = f.execute();
    const receiptDirectory = path.join(f.run, 'receipts');
    const add = async (name: string, value: unknown) => {
      const file = path.join(receiptDirectory, `${name}.json`);
      await writeFile(file, JSON.stringify(value));
      const reference = { path: `${name}.json`, sha256: hashFile(file) };
      receipt.artifacts![name] = reference;
      return reference;
    };
    // Synthetic inventories test the receipt validator; they are not runtime proof or benchmark results.
    const lock = await add('dependencyLock', { packages: { '': {}, 'node_modules/@wordpress/scripts': { version: '34.2.0' } } });
    await add('dependencyInventory', { lockSha256: lock.sha256, packages: [{ name: '@wordpress/scripts', version: '34.2.0' }] });
    await add('wordpressInventory', { version: '7.1', coreHash: `sha256:${'a'.repeat(64)}`, plugins: [] });
    await add('themeInventory', { slug: 'twentytwentyfive', version: 'test', configuration: JSON.parse(await readFile(path.join(suiteDirectory, 'fixtures/theme.json'), 'utf8')) });
    await add('browserInventory', { name: 'chromium', version: 'test', viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
    const evidence = await add('unitEvidence', { synthetic: true });
    receipt.status = 'scored';
    receipt.checks = Object.fromEntries(AUTHORING_DIMENSIONS.map((name) => [name, { pass: true, evidence }]));
    for (const [key, name] of Object.entries(AUTHORING_RUNTIME_ARTIFACTS)) receipt.provenance![key] = receipt.artifacts![name]!.sha256;
    expect(validateAuthoringReceipt(f.fixture, receipt, suiteDirectory, receiptDirectory)).toEqual([]);

    const schema = JSON.parse(await readFile(path.join(suiteDirectory, 'receipt.schema.json'), 'utf8'));
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
    receipt.provenance!.wordpressHash = null;
    expect(validate(receipt)).toBe(false);
    receipt.provenance!.wordpressHash = receipt.artifacts!.wordpressInventory!.sha256;
    const wrong = await add('browserInventory', { name: 'chromium', version: 'test', viewport: { width: 1, height: 1 }, deviceScaleFactor: 1 });
    receipt.provenance!.browserHash = wrong.sha256;
    expect(validateAuthoringReceipt(f.fixture, receipt, suiteDirectory, receiptDirectory))
      .toContain('browserInventory requires the observed Chromium version and 1440x1024 viewport at deviceScaleFactor 1');
  });
});
