import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { BlockRunnerConfig, MediaResolver } from '../types.js';
import { basenameForMedia, isRemoteUrl } from './resolver.js';

const execFileAsync = promisify(execFile);

export function createWpCliResolver(config: BlockRunnerConfig): MediaResolver {
  return {
    kind: 'wpcli',
    async resolve(input) {
      const allowRemote = config.media?.allowRemote === true;
      const value = input.urlOrPath;
      const filename = basenameForMedia(value);
      const existing = await lookup(filename, config);

      if (existing) {
        return {
          url: existing.url,
          id: existing.id,
          resolved: true,
        };
      }

      if (isRemoteUrl(value) && !allowRemote) {
        return {
          url: value,
          id: null,
          resolved: false,
          reason: 'remote media sideload is disabled',
        };
      }

      if (!isRemoteUrl(value) && !existsSync(value)) {
        return {
          url: value,
          id: null,
          resolved: false,
          reason: 'local media file not found',
        };
      }

      try {
        const args = wpArgs(config, ['media', 'import', value, '--porcelain']);
        const { stdout } = await execFileAsync('wp', args, { encoding: 'utf8' });
        const id = Number(stdout.trim());
        const imported = Number.isFinite(id) ? await lookup(String(id), config, 'id') : undefined;
        return {
          url: imported?.url ?? value,
          id: Number.isFinite(id) ? id : null,
          resolved: Number.isFinite(id),
          reason: Number.isFinite(id) ? undefined : 'wp media import did not return an ID',
        };
      } catch (error) {
        return {
          url: value,
          id: null,
          resolved: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

async function lookup(
  value: string,
  config: BlockRunnerConfig,
  mode: 'search' | 'id' = 'search',
): Promise<{ id: number; url: string } | undefined> {
  try {
    const args =
      mode === 'id'
        ? wpArgs(config, ['media', 'list', `--include=${value}`, '--fields=ID,url', '--format=json'])
        : wpArgs(config, ['media', 'list', `--search=${value}`, '--fields=ID,url', '--orderby=date', '--order=desc', '--format=json']);
    const { stdout } = await execFileAsync('wp', args, { encoding: 'utf8' });
    const rows = JSON.parse(stdout) as Array<{ ID?: number | string; id?: number | string; url?: string }>;
    const first = rows[0];
    const id = Number(first?.ID ?? first?.id);
    return first?.url && Number.isFinite(id) ? { id, url: first.url } : undefined;
  } catch {
    return undefined;
  }
}

function wpArgs(config: BlockRunnerConfig, args: string[]): string[] {
  return config.media?.wpUrl ? [`--url=${config.media.wpUrl}`, ...args] : args;
}
