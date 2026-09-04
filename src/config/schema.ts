import { BlockRunnerConfig, CommonOptions, ResolverKind, StylingRung } from '../types.js';

export const DEFAULT_CONFIG: Required<Pick<BlockRunnerConfig, 'strict'>> & BlockRunnerConfig = {
  strict: false,
  // S3: faithful where it matters (exact values survive) but output stays 100% native.
  styling: 'relaxed',
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
    styling: normalizeStyling(options.styling ?? config.styling),
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
    author: config.author
      ? {
          ...config.author,
          styles: config.author.styles ? { ...config.author.styles } : undefined,
        }
      : undefined,
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

// `source` (stop converting, keep the original markup as Custom HTML) is designed but not built;
// accepting it while behaving as `relaxed` would be a false API contract, so it is rejected until it
// exists. Note the converter already falls back to `core/html` for unconvertible *structure* — the
// `source` rung is the explicit, whole-element form of that.
const IMPLEMENTED_RUNGS: StylingRung[] = ['strict', 'relaxed', 'open'];
const PLANNED_RUNGS = ['source'];

function normalizeStyling(value: unknown): StylingRung {
  if (value === undefined || value === null) {
    return DEFAULT_CONFIG.styling as StylingRung;
  }
  if (IMPLEMENTED_RUNGS.includes(value as StylingRung)) {
    return value as StylingRung;
  }
  if (typeof value === 'string' && PLANNED_RUNGS.includes(value)) {
    throw new Error(
      `styling ceiling "${value}" is not implemented yet — use ${IMPLEMENTED_RUNGS.join(' or ')}`,
    );
  }
  throw new Error(
    `unknown styling ceiling ${JSON.stringify(value)} — expected ${IMPLEMENTED_RUNGS.join(' or ')}`,
  );
}

function isResolverKind(value: unknown): value is ResolverKind {
  return value === 'noop' || value === 'map' || value === 'wpcli' || value === 'rest';
}
