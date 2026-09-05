import { constants as fsConstants, readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { runProof } from '../src/proof/runner.js';

const collector = readFileSync(new URL('../scripts/collect-native-heading-control.mjs', import.meta.url), 'utf8');
const begin = collector.indexOf('async function prepareStageMount(');
const end = collector.indexOf('\nfunction ', begin + 1);
const prepare = (root: string) => (runInNewContext(`(${collector.slice(begin, end)})`, {
  ROOT: root, path, mkdir, access, fsConstants,
}) as () => Promise<void>)();

describe('WordPress control startup and retained failures', () => {
  it('keeps Docker ZIP staging outside WordPress media uploads', () => {
    const config = JSON.parse(readFileSync(new URL('../proof/wp-env.json', import.meta.url), 'utf8'));
    expect(config.mappings).toEqual({ 'wp-content/block-runner-proof': '.block-runner-proof-stage' });
    const runner = readFileSync(new URL('../src/proof/runner.ts', import.meta.url), 'utf8');
    expect(runner).toContain("const stagedZipContainerDirectory = '/var/www/html/wp-content/block-runner-proof'");
    expect(runner).toContain('wp_upload_bits($filename, null, $png)');
    expect(runner).toContain("if (!empty($upload['error']))");
    expect(runner).toContain("hash_file('sha256', $file) !== hash('sha256', $png)");
    expect(runner).not.toContain('file_put_contents($file, $png)');
  });

  it('creates the writable host staging directory before Docker startup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-control-stage-'));
    await prepare(root);
    const directory = path.join(root, '.block-runner-proof-stage');
    expect((await stat(directory)).isDirectory()).toBe(true);
    await writeFile(path.join(directory, 'existing.zip'), 'retained');
    await prepare(root);
    expect(await readFile(path.join(directory, 'existing.zip'), 'utf8')).toBe('retained');
    expect(collector.indexOf('await prepareStageMount();')).toBeLessThan(collector.indexOf("const start = await runCommand('npx'"));
  });

  it('refuses an incompatible existing stage path instead of replacing it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-control-stage-file-'));
    const file = path.join(root, '.block-runner-proof-stage');
    await writeFile(file, 'preserve');
    await expect(prepare(root)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('preserve');
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

  it('writes the receipt index before asserting the observed runtime', () => {
    const testSource = readFileSync(new URL('./proof-real-wordpress.test.ts', import.meta.url), 'utf8');
    expect(testSource.indexOf("path.join(outputDir, 'receipt-index.json')"))
      .toBeLessThan(testSource.indexOf('expect(result.receipt.environment.wordpress.version)'));
    for (const workflow of ['ci.yml', 'release.yml']) {
      const yaml = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8');
      expect(yaml).toContain('/**/node_modules/**');
      expect(yaml).toContain('if: always()');
    }
  });
});
