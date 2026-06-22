import { readFile } from 'node:fs/promises';
import { basenameForMedia, isRemoteUrl } from './resolver.js';
import { BlockRunnerConfig, MediaResolver } from '../types.js';

export function createRestResolver(config: BlockRunnerConfig): MediaResolver {
  return {
    kind: 'rest',
    async resolve(input) {
      const wpUrl = config.media?.wpUrl;
      if (!wpUrl) {
        return unresolved(input.urlOrPath, 'REST resolver requires wpUrl');
      }

      const filename = basenameForMedia(input.urlOrPath);
      const existing = await searchMedia(wpUrl, filename, config);
      if (existing) {
        return {
          url: existing.url,
          id: existing.id,
          resolved: true,
        };
      }

      if (isRemoteUrl(input.urlOrPath) && config.media?.allowRemote !== true) {
        return unresolved(input.urlOrPath, 'remote media sideload is disabled');
      }

      try {
        const bytes = isRemoteUrl(input.urlOrPath)
          ? Buffer.from(await (await fetch(input.urlOrPath)).arrayBuffer())
          : await readFile(input.urlOrPath);
        const response = await fetch(`${wpUrl.replace(/\/$/, '')}/wp-json/wp/v2/media`, {
          method: 'POST',
          headers: {
            Authorization: authorization(config),
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Type': contentType(filename),
          },
          body: bytes,
        });

        if (!response.ok) {
          return unresolved(input.urlOrPath, `REST media upload failed: ${response.status}`);
        }

        const json = (await response.json()) as { id?: number; source_url?: string };
        return {
          url: json.source_url ?? input.urlOrPath,
          id: json.id ?? null,
          resolved: Boolean(json.id),
          reason: json.id ? undefined : 'REST media upload did not return an ID',
        };
      } catch (error) {
        return unresolved(input.urlOrPath, error instanceof Error ? error.message : String(error));
      }
    },
  };
}

async function searchMedia(
  wpUrl: string,
  filename: string,
  config: BlockRunnerConfig,
): Promise<{ id: number; url: string } | undefined> {
  try {
    const url = new URL(`${wpUrl.replace(/\/$/, '')}/wp-json/wp/v2/media`);
    url.searchParams.set('search', filename);
    url.searchParams.set('per_page', '10');
    const response = await fetch(url, {
      headers: {
        Authorization: authorization(config),
      },
    });
    if (!response.ok) {
      return undefined;
    }
    const rows = (await response.json()) as Array<{ id?: number; source_url?: string }>;
    const first = rows[0];
    return first?.id && first.source_url ? { id: first.id, url: first.source_url } : undefined;
  } catch {
    return undefined;
  }
}

function authorization(config: BlockRunnerConfig): string {
  const user = config.media?.wpUser;
  const password = config.media?.wpAppPassword;
  return user && password ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : '';
}

function contentType(filename: string): string {
  if (/\.(jpe?g)$/i.test(filename)) {
    return 'image/jpeg';
  }
  if (/\.png$/i.test(filename)) {
    return 'image/png';
  }
  if (/\.webp$/i.test(filename)) {
    return 'image/webp';
  }
  if (/\.gif$/i.test(filename)) {
    return 'image/gif';
  }
  return 'application/octet-stream';
}

function unresolved(url: string, reason: string) {
  return {
    url,
    id: null,
    resolved: false,
    reason,
  };
}
