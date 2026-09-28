import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { startWithPreparedStageMount } from '../../scripts/proof-control-startup.mjs';
import { createWordPressProofLifecycle } from './proof-wordpress-lifecycle.js';
import { realize, validate } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wpEnvConfig = path.join(root, 'proof/wp-env.json');
const tabsFixture = path.join(root, 'dev/test/fixtures/tabs.intent.json');
const tabsBrowser = path.join(root, 'scripts/proof-tabs-playwright.mjs');
type CommandEvidence = { command: string; args: string[]; exitCode: number; stdout: string; stderr: string };

/** This explicit suite is the native Tabs runtime receipt, not a plugin proof profile. */
describe('native Tabs in WordPress 7.1', () => {
  it('preserves labels and content through native editing and independent frontend interaction', async () => {
    const outputDir = await tabsProofOutputDirectory();
    const token = `block-runner-tabs-${Date.now()}`;
    const lifecycle = createWordPressProofLifecycle(async (args) => {
      const result = await wpEnv([...args], commands);
      if (result.exitCode) throw new Error(result.stderr || result.stdout);
      if (args[0] === 'status') alreadyRunning = JSON.parse(result.stdout).status === 'running';
      return result;
    });
    let alreadyRunning = false;
    let dockerBlocked = false;
    let failure: unknown;
    const commands: CommandEvidence[] = [];
    try {
      try {
        await requireDocker(commands);
      } catch (error) {
        dockerBlocked = true;
        throw error;
      }
      await lifecycle.prepare();
      if (!alreadyRunning) {
        const started = await startWithPreparedStageMount({ root, start: () => wpEnv(['start'], commands) });
        if (started.exitCode) throw new Error(started.stderr || started.stdout);
      }
      // wp-env commands share mutable environment state, so concurrent CLI
      // invocations can make one lose the active environment mid-proof.
      const wordpressVersion = (await wp(['core', 'version'], commands)).stdout.trim();
      const phpVersion = (await wp(['eval', 'echo PHP_VERSION;'], commands)).stdout.trim();
      expect(wordpressVersion).toMatch(/^7\.1(?:\.\d+)?$/);
      expect(phpVersion).toMatch(/^8\.3(?:\.\d+)?$/);

      const fixture = JSON.parse(await readFile(tabsFixture, 'utf8'));
      const second = structuredClone(fixture.blocks[0]);
      second.attrs.activeTabIndex = 1;
      second.children[1].children[1].children.push(
        { block: 'core/heading', text: 'Rich panel heading' },
        { block: 'core/list', items: ['First item', 'Second item'] },
      );
      fixture.blocks.push(second);
      const assembled = await realize(JSON.stringify(fixture));
      expect(assembled.ok, JSON.stringify(assembled.items)).toBe(true);
      expect((await validate(assembled.output ?? '')).ok).toBe(true);
      const browserConfig = path.join(outputDir, 'tabs-proof.json');
      const browserOutput = path.join(outputDir, 'tabs-proof-result.json');
      await writeFile(browserConfig, `${JSON.stringify({
        baseUrl: 'http://localhost:8888', runtime: { wordpressVersion, phpVersion },
        fixture: JSON.stringify(fixture), markup: assembled.output, postTitle: `${token} proof`,
      }, null, 2)}\n`, 'utf8');
      const browser = await execFileAsync(process.execPath, [tabsBrowser, '--config', browserConfig, '--out', browserOutput], {
        cwd: root,
        timeout: 180_000,
      }).then(() => ({ exitCode: 0, stdout: '', stderr: '' }), (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => ({
        exitCode: 1, stdout: error.stdout ?? '', stderr: error.stderr || error.message,
      }));
      commands.push({ command: process.execPath, args: [tabsBrowser, '--config', browserConfig, '--out', browserOutput], exitCode: browser.exitCode, stdout: browser.stdout, stderr: browser.stderr });
      const evidence = existsSync(browserOutput) ? JSON.parse(await readFile(browserOutput, 'utf8')) : undefined;
      process.stderr.write(`${JSON.stringify({ tabsProofEvidence: outputDir, browserExitCode: browser.exitCode, errors: evidence?.errors ?? [] })}\n`);
      expect(browser.exitCode, JSON.stringify(evidence, null, 2)).toBe(0);
      expect(evidence?.errors).toEqual([]);
      expect(evidence?.editor?.reopened).toMatchObject({ isDirty: false, invalidBlocks: [] });
      expect(evidence?.frontend?.beforeEditor).toBeDefined();
      expect(evidence?.frontend?.nativeControl).toBeDefined();
      expect(evidence?.editor?.editedReopened).toMatchObject({ isDirty: false, invalidBlocks: [] });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await lifecycle.cleanup().catch(() => undefined);
      try {
        await writeFile(path.join(outputDir, 'commands.json'), `${JSON.stringify(commands, null, 2)}\n`, 'utf8');
        if (failure) {
          await writeFile(path.join(outputDir, 'failure.json'), `${JSON.stringify({
            status: 'failed',
            reason: failure instanceof Error ? failure.message : String(failure),
          }, null, 2)}\n`, 'utf8');
          if (dockerBlocked) {
            await writeFile(path.join(outputDir, 'runtime-blocked.json'), `${JSON.stringify({
              status: 'blocked',
              prerequisite: 'docker',
              reason: failure instanceof Error ? failure.message : String(failure),
            }, null, 2)}\n`, 'utf8');
          }
        }
      } catch (retentionError) {
        // Never replace the runtime failure with an evidence-write failure.
        if (failure) {
          process.stderr.write(`${JSON.stringify({ tabsProofEvidence: outputDir, retentionError: retentionError instanceof Error ? retentionError.message : String(retentionError) })}\n`);
        } else {
          throw retentionError;
        }
      }
      process.stderr.write(`${JSON.stringify({
        tabsProofEvidence: outputDir,
        failure: failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure),
      })}\n`);
    }
  }, 300_000);
});

async function wp(args: string[], commands: CommandEvidence[]) {
  const result = await wpEnv(['run', 'cli', 'wp', ...args], commands);
  if (result.exitCode !== 0) throw new Error(`wp ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result;
}

async function wpEnv(args: string[], commands: CommandEvidence[]) {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['--no-install', 'wp-env', `--config=${wpEnvConfig}`, ...args], { cwd: root, timeout: args[0] === 'start' ? 180_000 : 45_000 });
    const result = { command: 'npx', args: ['--no-install', 'wp-env', `--config=${wpEnvConfig}`, ...args], exitCode: 0, stdout, stderr };
    commands.push(result);
    return result;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const result = { command: 'npx', args: ['--no-install', 'wp-env', `--config=${wpEnvConfig}`, ...args], exitCode: 1, stdout: failure.stdout ?? '', stderr: `${failure.message}\n${failure.stderr ?? ''}` };
    commands.push(result);
    return result;
  }
}

/** CI supplies a retained root; local runs remain isolated in a temporary directory. */
async function tabsProofOutputDirectory(): Promise<string> {
  const configured = process.env.BLOCK_RUNNER_PROOF_OUTPUT_DIR;
  if (!configured) return mkdtemp(path.join(tmpdir(), 'block-runner-tabs-proof-'));
  const outputDir = path.resolve(configured, 'tabs');
  await mkdir(outputDir, { recursive: true });
  return outputDir;
}

async function requireDocker(commands: CommandEvidence[]) {
  try {
    const args = ['info', '--format', '{{.ServerVersion}}'];
    const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 15_000 });
    commands.push({ command: 'docker', args, exitCode: 0, stdout, stderr });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    commands.push({ command: 'docker', args: ['info', '--format', '{{.ServerVersion}}'], exitCode: 1, stdout: failure.stdout ?? '', stderr: `${failure.message}\n${failure.stderr ?? ''}` });
    throw new Error(`The native Tabs proof requires a working Docker CLI and daemon: ${error instanceof Error ? error.message : String(error)}`);
  }
}
