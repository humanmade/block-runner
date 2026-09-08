import { collect, stringifyManifest } from 'wesper';

export interface SiteContextOptions {
  wpUrl?: string;
  wpPath?: string;
  ssh?: string;
  wpBinary?: string;
  strict?: boolean;
}

/**
 * Collect a site.context.json manifest via wesper (WP-CLI collector).
 * Block Runner exposes the WP-CLI path; Wesper also offers REST collection directly.
 */
export async function collectSiteContext(options: SiteContextOptions): Promise<string> {
  const context = await collect({
    collector: 'wp-cli',
    wpUrl: options.wpUrl,
    wpPath: options.wpPath,
    ssh: options.ssh,
    wpBinary: options.wpBinary,
    strict: options.strict,
  });
  return stringifyManifest(context);
}
