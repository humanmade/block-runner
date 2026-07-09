import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BlockRunnerConfig, CommonOptions, TokenResolver } from '../types.js';
import { emptyTokens, parseThemeJsonSettings } from './resolver.js';

const cache = new Map<string, ReturnType<typeof emptyTokens>>();

export function createContextTokenResolver(config: BlockRunnerConfig, options: CommonOptions): TokenResolver {
  return {
    kind: 'context',
    async resolve() {
      const manifestPath = options.context ?? config.tokens?.context;
      if (!manifestPath) {
        return emptyTokens();
      }

      const resolved = path.resolve(manifestPath);
      const cached = cache.get(resolved);
      if (cached) {
        return cached;
      }

      if (!existsSync(resolved)) {
        return emptyTokens();
      }

      try {
        const manifest = JSON.parse(readFileSync(resolved, 'utf8')) as {
          theme?: { settings?: Parameters<typeof parseThemeJsonSettings>[0] };
        };
        const tokens = parseThemeJsonSettings(manifest.theme?.settings);
        cache.set(resolved, tokens);
        return tokens;
      } catch {
        return emptyTokens();
      }
    },
  };
}
