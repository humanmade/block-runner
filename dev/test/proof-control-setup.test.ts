import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProof } from '../../src/proof/runner.js';
import { startWithPreparedStageMount } from '../../scripts/proof-control-startup.mjs';

describe('WordPress control startup and retained failures', () => {
  it('makes host staging writable and preserves ZIPs before starting Docker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-control-stage-'));
    const directory = path.join(root, '.block-runner-proof-stage');
    await startWithPreparedStageMount({ root, start: async () => {
      expect((await stat(directory)).isDirectory()).toBe(true);
      await access(directory, fsConstants.W_OK);
      await writeFile(path.join(directory, 'startup-write-probe'), 'writable');
    } });
    await writeFile(path.join(directory, 'existing.zip'), 'retained');
    let observed: string | undefined;
    await startWithPreparedStageMount({ root, start: async () => {
      await access(directory, fsConstants.W_OK);
      observed = await readFile(path.join(directory, 'existing.zip'), 'utf8');
    } });
    expect(observed).toBe('retained');
  });

  it('rejects a non-writable existing stage directory without starting Docker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-control-stage-read-only-'));
    const directory = path.join(root, '.block-runner-proof-stage');
    await mkdir(directory);
    await chmod(directory, 0o555);
    let started = false;
    try {
      await expect(startWithPreparedStageMount({ root, start: async () => { started = true; } })).rejects.toThrow();
      expect(started).toBe(false);
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it('preserves an incompatible existing stage path and never starts Docker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-control-stage-file-'));
    const file = path.join(root, '.block-runner-proof-stage');
    await writeFile(file, 'preserve');
    let started = false;
    await expect(startWithPreparedStageMount({ root, start: async () => { started = true; } })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('preserve');
    expect(started).toBe(false);
  });

  it('installs a byte-identical staged ZIP through the non-media wp-env mount', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-staged-zip-'));
    const zip = path.join(root, 'candidate.zip');
    const input = path.join(root, 'input.json');
    const zipBytes = Buffer.from(`zip-${root}`);
    await Promise.all([writeFile(zip, zipBytes), writeFile(input, '{}')]);
    const commands: Array<{ command: string; args: string[] }> = [];
    let stagedHostPath: string | undefined;
    try {
      await runProof({
        profile: 'runtime', pluginZip: zip, inputPath: input, outputDir: path.join(root, 'proof'),
        fixture: { blockName: 'test/fixture' },
        commandRunner: async (command, args) => {
          commands.push({ command, args: [...args] });
          const installAt = args.indexOf('install');
          if (command === 'npx' && installAt >= 0 && args[installAt - 1] === 'plugin') {
            stagedHostPath = path.join(process.cwd(), '.block-runner-proof-stage', path.basename(args[installAt + 1]!));
            return { command, args: [...args], exitCode: 1, stdout: '', stderr: 'test adapter stops after observing installation' };
          }
          return { command, args: [...args], exitCode: 0, stdout: '', stderr: '' };
        },
      });
      const install = commands.find(({ command, args }) => command === 'npx' && args.includes('plugin') && args.includes('install'));
      expect(install).toBeDefined();
      const stagedContainerPath = install!.args[install!.args.indexOf('install') + 1]!;
      expect(stagedContainerPath).toMatch(/^\/var\/www\/html\/wp-content\/block-runner-proof\/[^/]+\.zip$/);
      expect(stagedContainerPath).not.toContain('uploads');
      expect(stagedHostPath).toBeDefined();
      expect(await readFile(stagedHostPath!)).toEqual(zipBytes);
    } finally {
      if (stagedHostPath) await unlink(stagedHostPath).catch(() => undefined);
    }
  });

  it('retains one staging failure without repeatedly probing Docker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-stage-failure-'));
    const zip = path.join(root, 'candidate.zip');
    const input = path.join(root, 'input.json');
    await writeFile(zip, 'never-installed');
    await writeFile(input, '{}');
    const commands: string[] = [];
    const result = await runProof({
      profile: 'full', pluginZip: zip, inputPath: input, outputDir: path.join(root, 'proof'),
      fixture: { blockName: 'test/fixture' },
      commandRunner: async (command, args) => {
        commands.push([command, ...args].join(' '));
        if (command !== 'docker') throw new Error('No runtime command should follow a failed ZIP staging step.');
        await rename(zip, `${zip}.retained`);
        return { command, args: [...args], exitCode: 0, stdout: '29.0.0', stderr: '' };
      },
    });
    expect(commands).toEqual(['docker info --format {{.ServerVersion}}']);
    expect(result.receipt.gates.some(({ reason }) => reason?.includes('Could not stage the plugin ZIP'))).toBe(true);
    expect(result.ok).toBe(false);
  });
});
