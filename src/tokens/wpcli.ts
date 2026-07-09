import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BlockRunnerConfig, ResolvedTokens, TokenResolver } from '../types.js';
import { emptyTokens, parseThemeJsonSettings } from './resolver.js';

const execFileAsync = promisify(execFile);

const cache = new Map<string, ResolvedTokens>();

export function createWpCliTokenResolver(config: BlockRunnerConfig): TokenResolver {
  return {
    kind: 'wpcli',
    async resolve() {
      const wpUrl = config.media?.wpUrl ?? '';
      const cached = cache.get(wpUrl);
      if (cached) {
        return cached;
      }

      try {
        const args = wpArgs(config, [
          'eval',
          'echo json_encode(WP_Theme_JSON_Resolver::get_theme_data()->get_settings());',
        ]);
        const { stdout } = await execFileAsync('wp', args, { encoding: 'utf8' });
        const settings = JSON.parse(stdout) as Parameters<typeof parseThemeJsonSettings>[0];
        const tokens = parseThemeJsonSettings(settings);
        cache.set(wpUrl, tokens);
        return tokens;
      } catch {
        return emptyTokens();
      }
    },
  };
}

function wpArgs(config: BlockRunnerConfig, args: string[]): string[] {
  return config.media?.wpUrl ? [`--url=${config.media.wpUrl}`, ...args] : args;
}
