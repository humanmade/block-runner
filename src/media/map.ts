import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BlockRunnerConfig, MediaMapEntry, MediaResolver } from '../types.js';
import { basenameForMedia } from './resolver.js';

export function createMapResolver(config: BlockRunnerConfig): MediaResolver {
  const map = loadMap(config);

  return {
    kind: 'map',
    async resolve(input) {
      const key = basenameForMedia(input.urlOrPath);
      const entry = map[key] ?? map[input.urlOrPath];
      if (!entry?.id) {
        return {
          url: entry?.url ?? input.urlOrPath,
          id: entry?.id ?? null,
          resolved: false,
          reason: `media map has no ID for ${key}`,
        };
      }

      return {
        url: entry.url ?? input.urlOrPath,
        id: entry.id,
        resolved: true,
      };
    },
  };
}

function loadMap(config: BlockRunnerConfig): Record<string, MediaMapEntry> {
  if (config.media?.map) {
    return config.media.map;
  }

  if (!config.media?.mapFile) {
    return {};
  }

  const resolved = path.resolve(config.media.mapFile);
  if (!existsSync(resolved)) {
    return {};
  }

  return JSON.parse(readFileSync(resolved, 'utf8')) as Record<string, MediaMapEntry>;
}
