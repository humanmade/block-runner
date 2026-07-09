import { afterEach, describe, expect, it, vi } from 'vitest';

const collect = vi.fn(async () => ({ contextVersion: 1 }));
const stringifyManifest = vi.fn(() => '{"ok":true}\n');

vi.mock('wesper', () => ({ collect, stringifyManifest }));

const { collectSiteContext } = await import('../src/context/run.js');

describe('collectSiteContext', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to the wp-cli collector with path and ssh', async () => {
    await collectSiteContext({
      wpPath: '/srv/www',
      ssh: 'user@host',
    });

    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        collector: 'wp-cli',
        wpPath: '/srv/www',
        ssh: 'user@host',
      }),
    );
  });

  it('forwards wpUrl and optional flags', async () => {
    await collectSiteContext({
      wpUrl: 'https://example.test',
      wpBinary: 'wp',
      strict: true,
    });

    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        collector: 'wp-cli',
        wpUrl: 'https://example.test',
        wpBinary: 'wp',
        strict: true,
      }),
    );
  });

  it('returns the stringified manifest', async () => {
    const result = await collectSiteContext({});

    expect(stringifyManifest).toHaveBeenCalledWith({ contextVersion: 1 });
    expect(result).toBe('{"ok":true}\n');
  });
});
