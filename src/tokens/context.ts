import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validate } from 'wesper';
import { BlockRunnerConfig, CommonOptions, TokenResolver } from '../types.js';
import { emptyTokens } from './resolver.js';
import { isFocusedContext, tokensFromWesperContext } from './wesper.js';

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
        const input: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
        // A full SiteContext has Wesper's public validation entry point. Its
        // focused projection deliberately is not a manifest, so recognize its
        // public discriminator before adapting the shared native-token records.
        const validated = validate(input);
        const tokens = validated.ok && validated.context
          ? tokensFromWesperContext(validated.context)
          : isFocusedContext(input)
            ? tokensFromWesperContext(input)
            : emptyTokens();
        cache.set(resolved, tokens);
        return tokens;
      } catch {
        return emptyTokens();
      }
    },
  };
}
