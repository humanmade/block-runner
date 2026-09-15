import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteContext } from 'wesper';

const collectedContext = {
  $schema: 'https://humanmade.github.io/wesper/schemas/site-context-v1.schema.json',
  contextVersion: 1,
  site: { environment: 'local', isMultisite: false },
  provenance: {
    collectedAt: '2026-09-15T00:00:00.000Z',
    collector: 'wp-cli',
    collectorVersion: '0.2.3',
    sourceHash: 'sha256:fixture',
    partial: true,
  },
  blocks: {
    types: [{
      name: 'acme/catalog',
      attributes: {},
      supports: {},
      source: 'plugin',
      owner: { status: 'unknown', reason: 'scan_incomplete' },
    }],
  },
  contentModel: {
    postTypes: [{
      name: 'product',
      taxonomies: ['product_cat'],
      fields: [],
      owner: { status: 'unknown', reason: 'incomplete_registration_trace' },
    }],
    taxonomies: [{
      name: 'product_cat',
      objectTypes: ['product'],
      owner: { status: 'unknown', reason: 'incomplete_registration_trace' },
    }],
  },
  warnings: [],
} satisfies SiteContext;

const collect = vi.fn(async () => collectedContext);
const stringifyManifest = vi.fn((_context: SiteContext) => '{"ok":true}\n');

vi.mock('wesper', () => ({ collect, stringifyManifest }));

const { collectSiteContext } = await import('../../src/context/run.js');

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

  it('passes newer optional ownership and taxonomy associations to Wesper unchanged', async () => {
    const result = await collectSiteContext({});

    expect(stringifyManifest.mock.calls[0]?.[0]).toBe(collectedContext);
    expect(collectedContext.contentModel).toMatchObject({
      postTypes: [{ name: 'product', taxonomies: ['product_cat'], owner: { status: 'unknown' } }],
      taxonomies: [{ name: 'product_cat', objectTypes: ['product'], owner: { status: 'unknown' } }],
    });
    expect(result).toBe('{"ok":true}\n');
  });
});
