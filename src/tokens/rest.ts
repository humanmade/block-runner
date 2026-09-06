import { collect } from 'wesper';
import { BlockRunnerConfig, ResolvedTokens, TokenResolver } from '../types.js';
import { emptyTokens } from './resolver.js';
import { tokensFromWesperContext } from './wesper.js';

const cache = new Map<string, ResolvedTokens>();

export function createRestTokenResolver(config: BlockRunnerConfig): TokenResolver {
  return {
    kind: 'rest',
    async resolve() {
      const wpUrl = config.media?.wpUrl;
      if (!wpUrl) {
        return emptyTokens();
      }

      const cached = cache.get(wpUrl);
      if (cached) {
        return cached;
      }

      try {
        const context = await collect({
          collector: 'rest',
          wpUrl,
          wpUser: config.media?.wpUser,
          wpAppPassword: config.media?.wpAppPassword,
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
