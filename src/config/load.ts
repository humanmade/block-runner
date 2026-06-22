import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BlockRunnerConfig, CommonOptions } from '../types.js';
import { mergeConfig } from './schema.js';

const DEFAULT_CONFIG_FILES = [
  'block-runner.config.mjs',
  'block-runner.config.js',
  'block-runner.config.json',
];

export async function loadConfig(options: CommonOptions & { config?: BlockRunnerConfig } = {}): Promise<BlockRunnerConfig> {
  const explicitConfig = options.configPath ? await readConfigFile(options.configPath) : undefined;
  const discoveredConfig = explicitConfig ?? (await discoverConfig());
  return mergeConfig(options.config ?? discoveredConfig ?? {}, options);
}

async function discoverConfig(): Promise<BlockRunnerConfig | undefined> {
  for (const candidate of DEFAULT_CONFIG_FILES) {
    const resolved = path.resolve(candidate);
    if (existsSync(resolved)) {
      return readConfigFile(resolved);
    }
  }

  return undefined;
}

async function readConfigFile(filePath: string): Promise<BlockRunnerConfig> {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  if (resolved.endsWith('.json')) {
    return JSON.parse(await readFile(resolved, 'utf8')) as BlockRunnerConfig;
  }

  const imported = (await import(`${pathToFileURL(resolved).href}?t=${Date.now()}`)) as {
    default?: BlockRunnerConfig;
  };
  return imported.default ?? (imported as BlockRunnerConfig);
}
