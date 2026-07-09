import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BlockRunnerConfig, CommonOptions, TokenResolver } from '../types.js';
import { emptyTokens, parseThemeJsonSettings } from './resolver.js';

const cache = new Map<string, ReturnType<typeof emptyTokens>>();

export function createFileTokenResolver(config: BlockRunnerConfig, options: CommonOptions): TokenResolver {
  return {
    kind: 'file',
    async resolve() {
      // TODO: parent/child/core theme.json merge — MVP reads a single file.
      const themeJson = options.themeJson ?? config.tokens?.themeJson;
      if (!themeJson) {
        return emptyTokens();
      }

      const resolved = path.resolve(themeJson);
      const cached = cache.get(resolved);
      if (cached) {
        return cached;
      }

      if (!existsSync(resolved)) {
        return emptyTokens();
      }

      try {
        const json = JSON.parse(readFileSync(resolved, 'utf8')) as { settings?: Parameters<typeof parseThemeJsonSettings>[0] };
        const tokens = parseThemeJsonSettings(json.settings);
        cache.set(resolved, tokens);
        return tokens;
      } catch {
        return emptyTokens();
      }
    },
  };
}
