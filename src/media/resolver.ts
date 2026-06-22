import path from 'node:path';
import { BlockRunnerConfig, CommonOptions, MediaResolver, ResolverKind } from '../types.js';
import { createMapResolver } from './map.js';
import { createNoopResolver } from './noop.js';
import { createRestResolver } from './rest.js';
import { createWpCliResolver } from './wpcli.js';

export function createMediaResolver(
  config: BlockRunnerConfig,
  options: CommonOptions = {},
): MediaResolver {
  const kind = (options.resolver ?? config.media?.resolver ?? 'noop') as ResolverKind;

  switch (kind) {
    case 'map':
      return createMapResolver(config);
    case 'wpcli':
      return createWpCliResolver(config);
    case 'rest':
      return createRestResolver(config);
    case 'noop':
    default:
      return createNoopResolver();
  }
}

export function basenameForMedia(value: string): string {
  try {
    const url = new URL(value);
    return path.basename(url.pathname);
  } catch {
    return path.basename(value);
  }
}

export function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
