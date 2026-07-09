import { BlockRunnerConfig, CommonOptions, ResolverKind } from '../types.js';

export const DEFAULT_CONFIG: Required<Pick<BlockRunnerConfig, 'strict'>> & BlockRunnerConfig = {
  strict: false,
  media: {
    resolver: 'noop',
    allowRemote: false,
    reuse: true,
  },
  tokens: {
    colors: {},
    fonts: {},
    fontSizes: {},
    spacing: [],
    match: 'exact',
    resolver: 'noop',
  },
  rules: {
    disabledDefaults: [],
    order: [],
    custom: [],
  },
};

export function mergeConfig(config: BlockRunnerConfig = {}, options: CommonOptions = {}): BlockRunnerConfig {
  const mediaResolver = options.resolver ?? config.media?.resolver ?? DEFAULT_CONFIG.media?.resolver;
  const resolver = isResolverKind(mediaResolver) ? mediaResolver : 'noop';

  return {
    strict: options.strict ?? config.strict ?? DEFAULT_CONFIG.strict,
    media: {
      ...DEFAULT_CONFIG.media,
      ...config.media,
      resolver,
      wpUrl: options.wpUrl ?? config.media?.wpUrl,
      wpUser: options.wpUser ?? config.media?.wpUser,
      wpAppPassword: options.wpAppPassword ?? config.media?.wpAppPassword,
    },
    tokens: {
      colors: {
        ...DEFAULT_CONFIG.tokens?.colors,
        ...config.tokens?.colors,
      },
      fonts: {
        ...DEFAULT_CONFIG.tokens?.fonts,
        ...config.tokens?.fonts,
      },
      fontSizes: {
        ...DEFAULT_CONFIG.tokens?.fontSizes,
        ...config.tokens?.fontSizes,
      },
      spacing: config.tokens?.spacing ?? DEFAULT_CONFIG.tokens?.spacing,
      match: options.tokenMatch ?? config.tokens?.match ?? 'exact',
      resolver:
        options.tokenResolver ??
        config.tokens?.resolver ??
        ((options.context ?? config.tokens?.context) ? 'context' : 'noop'),
      themeJson: options.themeJson ?? config.tokens?.themeJson,
      context: options.context ?? config.tokens?.context,
    },
    rules: normalizeRules(config.rules),
  };
}

export function normalizeRules(rules: BlockRunnerConfig['rules']): Exclude<BlockRunnerConfig['rules'], unknown[]> {
  if (Array.isArray(rules)) {
    return {
      disabledDefaults: [],
      order: [],
      custom: rules,
    };
  }

  return {
    disabledDefaults: rules?.disabledDefaults ?? [],
    order: rules?.order ?? [],
    custom: rules?.custom ?? [],
  };
}

function isResolverKind(value: unknown): value is ResolverKind {
  return value === 'noop' || value === 'map' || value === 'wpcli' || value === 'rest';
}
