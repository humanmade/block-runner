import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { startWithPreparedStageMount } from '../../scripts/proof-control-startup.mjs';
import { realize, validate } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wpEnvConfig = path.join(root, 'proof/wp-env.json');
const queryFixture = path.join(root, 'dev/test/fixtures/query-loop.intent.json');
const queryBrowser = path.join(root, 'scripts/proof-query-playwright.mjs');

/** This explicit suite is the native Query Loop runtime receipt, not a plugin proof profile. */
describe('native Query Loop in WordPress 7.1', () => {
  it('assembles, saves, reopens, paginates, and renders no results from the shared intent fixture', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'block-runner-query-proof-'));
    try {
      await requireDocker();
    } catch (error) {
      const blocked = { status: 'blocked', prerequisite: 'docker', reason: error instanceof Error ? error.message : String(error) };
      await writeFile(path.join(outputDir, 'runtime-blocked.json'), `${JSON.stringify(blocked, null, 2)}\n`, 'utf8');
      process.stderr.write(`${JSON.stringify({ queryProofEvidence: outputDir, blocked })}\n`);
      throw error;
    }
    const token = `block-runner-query-${Date.now()}`;
    let startedHere = false;
    const commands: Array<{ command: string; args: string[]; stdout: string; stderr: string }> = [];
    try {
      const status = await wpEnv(['status'], commands).catch(() => undefined);
      startedHere = !/running/i.test(`${status?.stdout ?? ''}\n${status?.stderr ?? ''}`);
      if (startedHere) {
        const started = await startWithPreparedStageMount({
          root,
          start: () => wpEnv(['start'], commands),
        });
        if (started.exitCode !== 0) throw new Error(`Pinned WordPress 7.1 environment did not start: ${started.stderr || started.stdout}`);
      }
      const [wordpressVersion, phpVersion] = await Promise.all([
        wp(['core', 'version'], commands).then((result) => result.stdout.trim()),
        wp(['eval', 'echo PHP_VERSION;'], commands).then((result) => result.stdout.trim()),
      ]);
      expect(wordpressVersion).toMatch(/^7\.1(?:\.\d+)?$/);
      expect(phpVersion).toMatch(/^8\.3(?:\.\d+)?$/);

      const categoryId = Number((await wp(['term', 'create', 'category', token, '--porcelain'], commands)).stdout.trim());
      if (!Number.isInteger(categoryId) || categoryId <= 0) throw new Error('Could not create the isolated Query Loop category.');
      const firstId = Number((await wp([
        'post', 'create', '--post_status=publish', `--post_title=${token} first`, '--post_content=First seeded Query Loop post.',
        '--post_date=2024-01-01 00:00:00', `--post_category=${categoryId}`, '--porcelain',
      ], commands)).stdout.trim());
      const secondId = Number((await wp([
        'post', 'create', '--post_status=publish', `--post_title=${token} second`, '--post_content=Second seeded Query Loop post.',
        '--post_date=2024-01-02 00:00:00', `--post_category=${categoryId}`, '--porcelain',
      ], commands)).stdout.trim());
      const [firstLink, secondLink] = await Promise.all([firstId, secondId].map(async (id) => (await wp(['post', 'get', String(id), '--field=url'], commands)).stdout.trim()));
      if (!firstLink || !secondLink) throw new Error('Could not read the seeded post links.');

      const fixture = JSON.parse(await readFile(queryFixture, 'utf8')) as { blocks: Array<{ attrs?: Record<string, unknown> }> };
      const bound = structuredClone(fixture);
      const query = bound.blocks[0]?.attrs?.query as Record<string, unknown> | undefined;
      if (!query) throw new Error('The shared Query Loop fixture has no query attributes to bind.');
      // Current native Query Loop uses taxQuery. categoryIds selects a
      // deprecated block version, which makes the otherwise-valid current
      // Post Template markup fail the gate before the browser can open it.
      const boundQuery = { ...query, taxQuery: { include: { category: [categoryId] } } };
      bound.blocks[0]!.attrs = { ...bound.blocks[0]!.attrs, query: boundQuery };
      const assembled = await realize(JSON.stringify(bound));
      expect(assembled.ok, JSON.stringify(assembled.items)).toBe(true);
      expect((await validate(assembled.output ?? '')).ok).toBe(true);
      const unmatched = structuredClone(bound);
      const unmatchedQuery = { ...boundQuery, search: `${token}-absent` };
      unmatched.blocks[0]!.attrs = { ...unmatched.blocks[0]!.attrs, query: unmatchedQuery };
      const empty = await realize(JSON.stringify(unmatched));
      expect(empty.ok, JSON.stringify(empty.items)).toBe(true);
      const emptyId = Number((await wp([
        'post', 'create', '--post_status=publish', `--post_title=${token} empty`, `--post_content=${empty.output}`, '--porcelain',
      ], commands)).stdout.trim());
      const emptyLink = (await wp(['post', 'get', String(emptyId), '--field=url'], commands)).stdout.trim();
      if (!Number.isInteger(emptyId) || emptyId <= 0 || !emptyLink) throw new Error('Could not publish the empty Query Loop proof post.');

      const browserConfig = path.join(outputDir, 'query-proof.json');
      const browserOutput = path.join(outputDir, 'query-proof-result.json');
      await writeFile(browserConfig, `${JSON.stringify({
        baseUrl: 'http://localhost:8888',
        runtime: { wordpressVersion, phpVersion },
        fixture: JSON.stringify(fixture),
        markup: assembled.output,
        emptyMarkup: empty.output,
        emptyPermalink: emptyLink,
        boundQuery,
        seeded: [
          { id: firstId, title: `${token} first`, link: firstLink },
          { id: secondId, title: `${token} second`, link: secondLink },
        ],
        postTitle: `${token} proof`,
      }, null, 2)}\n`, 'utf8');
      const browser = await execFileAsync(process.execPath, [queryBrowser, '--config', browserConfig, '--out', browserOutput], {
        cwd: root,
        timeout: 180_000,
      }).then(() => ({ exitCode: 0, stdout: '', stderr: '' }), (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => ({
        exitCode: 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message,
      }));
      commands.push({ command: process.execPath, args: [queryBrowser, '--config', browserConfig, '--out', browserOutput], stdout: browser.stdout, stderr: browser.stderr });
      const evidence = existsSync(browserOutput) ? JSON.parse(await readFile(browserOutput, 'utf8')) : undefined;
      await writeFile(path.join(outputDir, 'commands.json'), `${JSON.stringify(commands, null, 2)}\n`, 'utf8');
      process.stderr.write(`${JSON.stringify({ queryProofEvidence: outputDir, browserExitCode: browser.exitCode, errors: evidence?.errors ?? [] })}\n`);
      expect(browser.exitCode, JSON.stringify(evidence, null, 2)).toBe(0);
      expect(evidence?.errors).toEqual([]);
      expect(evidence?.editor?.reopened).toMatchObject({ isDirty: false, invalidBlocks: [] });
      expect(evidence?.pagination?.first).toHaveLength(1);
      expect(evidence?.pagination?.second).toHaveLength(1);
      expect(evidence?.pagination).toMatchObject({ firstStatus: 200, secondStatus: 200, returnedStatus: 200 });
      expect(evidence?.emptyResults).toMatchObject({ nextVisible: false });
    } finally {
      if (startedHere) await wpEnv(['stop'], commands).catch(() => undefined);
    }
  }, 300_000);
});

async function wp(args: string[], commands: Array<{ command: string; args: string[]; stdout: string; stderr: string }>) {
  const result = await wpEnv(['run', 'cli', 'wp', ...args], commands);
  if (result.exitCode !== 0) throw new Error(`wp ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result;
}

async function wpEnv(args: string[], commands: Array<{ command: string; args: string[]; stdout: string; stderr: string }>) {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['--no-install', 'wp-env', `--config=${wpEnvConfig}`, ...args], { cwd: root, timeout: args[0] === 'start' ? 180_000 : 45_000 });
    const result = { command: 'npx', args: ['--no-install', 'wp-env', `--config=${wpEnvConfig}`, ...args], exitCode: 0, stdout, stderr };
    commands.push(result);
    return result;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const result = { command: 'npx', args: ['--no-install', 'wp-env', `--config=${wpEnvConfig}`, ...args], exitCode: 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message };
    commands.push(result);
    return result;
  }
}

async function requireDocker() {
  try {
    await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15_000 });
  } catch (error) {
    throw new Error(`The native Query Loop proof requires a working Docker CLI and daemon: ${error instanceof Error ? error.message : String(error)}`);
  }
}
