import { describe, expect, it } from 'vitest';
import { createWordPressProofLifecycle } from './proof-wordpress-lifecycle.js';

describe('WordPress proof lifecycle', () => {
  it('stops an environment this suite found stopped even when a proof fails', async () => {
    const commands: string[][] = [];
    const lifecycle = createWordPressProofLifecycle(async (args) => {
      commands.push([...args]);
      return { stdout: args[0] === 'status' ? '{"status":"uninitialized"}' : '', stderr: '' };
    });

    await lifecycle.prepare();
    await lifecycle.cleanup();

    expect(commands).toEqual([['status', '--json'], ['stop']]);
  });

  it('leaves a pre-existing environment for its owner', async () => {
    const commands: string[][] = [];
    const lifecycle = createWordPressProofLifecycle(async (args) => {
      commands.push([...args]);
      return { stdout: '{"status":"running"}', stderr: '' };
    });

    await lifecycle.prepare();
    await lifecycle.cleanup();

    expect(commands).toEqual([['status', '--json']]);
  });

  it('refuses an unknown status without stopping an environment', async () => {
    const commands: string[][] = [];
    const lifecycle = createWordPressProofLifecycle(async (args) => {
      commands.push([...args]);
      return { stdout: '{"status":"unknown"}', stderr: '' };
    });

    await expect(lifecycle.prepare()).rejects.toThrow('Unknown wp-env runtime status');
    await lifecycle.cleanup();

    expect(commands).toEqual([['status', '--json']]);
  });

  it('refuses a failed status probe without stopping an environment', async () => {
    const commands: string[][] = [];
    const lifecycle = createWordPressProofLifecycle(async (args) => {
      commands.push([...args]);
      throw new Error('wp-env status failed');
    });

    await expect(lifecycle.prepare()).rejects.toThrow('wp-env status failed');
    await lifecycle.cleanup();

    expect(commands).toEqual([['status', '--json']]);
  });
});
