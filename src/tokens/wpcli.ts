import process from 'node:process';
import { collect } from 'wesper';
import { BlockRunnerConfig, ResolvedTokens, TokenResolver } from '../types.js';
import { emptyTokens } from './resolver.js';
import { tokensFromWesperContext } from './wesper.js';

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
        // Keep Block Runner's legacy discovery point while Wesper owns all
        // WP-CLI collection and normalization.
        const context = await collect({
          collector: 'wp-cli',
          wpUrl: config.media?.wpUrl,
          wpPath: process.cwd(),
        });
        const tokens = tokensFromWesperContext(context);
        cache.set(wpUrl, tokens);
        return tokens;
      } catch {
        return emptyTokens();
      }
    },
  };
}
