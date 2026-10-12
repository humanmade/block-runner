import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { discoverThemeMarkupFiles } from '../theme/folders.js';
import type { EvidenceStore } from './receipt.js';

export interface ThemeProofFile {
  file: string;
  kind: 'template' | 'part';
  content: string;
}

export interface PreparedThemeProof {
  root: string;
  slug: string;
  version: string;
  requiresPhp?: string;
  files: ThemeProofFile[];
  snapshot: { sha256: `sha256:${string}`; bytes: number; evidence: import('./receipt.js').EvidenceReference };
  manifest: { files: { file: string; sha256: `sha256:${string}`; bytes: number }[] };
}

export interface ThemeWpEnvConfig {
  [key: string]: unknown;
  phpVersion?: string | null;
  core?: string | null;
  port?: number;
  autoPort?: boolean;
  config?: Record<string, unknown>;
  plugins?: string[];
  themes?: string[];
  mappings?: Record<string, string>;
  env?: { development?: Record<string, unknown>; [key: string]: unknown };
}

export function compareThemeMarkup(source: string, saved: string, themeSlug: string): {
  equal: boolean;
  firstDifferenceByte?: number;
  sourceBytes: number;
  savedBytes: number;
  sourceNormalized: string;
  savedNormalized: string;
} {
  const sourceNormalized = removeThemeAttributes(source, themeSlug);
  const savedNormalized = removeThemeAttributes(saved, themeSlug);
  const left = Buffer.from(sourceNormalized, 'utf8');
  const right = Buffer.from(savedNormalized, 'utf8');
  let offset = 0;
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) offset++;
  return {
    equal: offset === left.length && offset === right.length,
    ...(offset < left.length || offset < right.length ? { firstDifferenceByte: offset } : {}),
    sourceBytes: left.length,
    savedBytes: right.length,
    sourceNormalized,
    savedNormalized,
  };
}

/** Remove only the matching top-level theme attribute from core/template-part comment JSON. */
export function removeThemeAttributes(markup: string, themeSlug: string): string {
  return markup.replace(/<!--\s*wp:(?:core\/)?template-part\b([^]*?)-->/g, (comment, body: string) => {
    const objectStart = body.indexOf('{');
    if (objectStart < 0) return comment;
    const objectEnd = jsonObjectEnd(body, objectStart);
    if (objectEnd < 0) return comment;
    const object = body.slice(objectStart, objectEnd + 1);
    const range = topLevelPropertyRange(object, 'theme', themeSlug);
    if (!range) return comment;
    const replaced = object.slice(0, range[0]) + object.slice(range[1]);
    return comment.replace(object, replaced);
  });
}

export async function prepareThemeProof(themeDirectory: string, evidence: EvidenceStore): Promise<PreparedThemeProof> {
  const root = path.resolve(themeDirectory);
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error(`Theme proof needs a direct local theme directory: ${root}`);
  const stylePath = path.join(root, 'style.css');
  const style = await readFile(stylePath, 'utf8');
  const header = /^\/\*([\s\S]*?)\*\//.exec(style)?.[1] ?? '';
  const value = (name: string): string | undefined => new RegExp(`^\\s*${name}:\\s*(.*?)\\s*$`, 'im').exec(header)?.[1]?.trim();
  const slug = path.basename(root);
  if (!value('Theme Name')) throw new Error(`Theme ${root} has no Theme Name in style.css.`);
  const requiresPhp = value('Requires PHP');
  const files = (await discoverThemeMarkupFiles(root))
    .filter((file) => file.kind === 'template' || file.kind === 'part')
    .map((file) => ({ file: file.file, kind: file.kind as 'template' | 'part', content: file.content }));
  if (files.length === 0) throw new Error(`Theme ${root} contains no templates/*.html or parts/*.html files.`);

  const manifestFiles: { file: string; sha256: `sha256:${string}`; bytes: number }[] = [];
  for (const file of await listThemeFiles(root)) {
    const bytes = await readFile(path.join(root, file));
    const evidenceRef = await evidence.put(bytes, { mediaType: 'application/octet-stream' });
    manifestFiles.push({ file, sha256: evidenceRef.sha256, bytes: evidenceRef.bytes });
  }
  const manifest = { files: manifestFiles };
  for (const file of files) {
    const bytes = Buffer.from(file.content, 'utf8');
    const pinned = manifestFiles.find((entry) => entry.file === file.file);
    if (!pinned || pinned.sha256 !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`) {
      throw new Error(`Theme source changed while the proof snapshot was being captured: ${file.file}`);
    }
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const snapshotEvidence = await evidence.put(manifestBytes, { mediaType: 'application/json' });
  return {
    root,
    slug,
    version: value('Version') ?? '0.0.0',
    ...(requiresPhp ? { requiresPhp } : {}),
    files,
    snapshot: { sha256: snapshotEvidence.sha256, bytes: snapshotEvidence.bytes, evidence: snapshotEvidence },
    manifest,
  };
}

export function effectiveWpEnvConfig(config: ThemeWpEnvConfig): {
  phpVersion: string | undefined;
  core: string | undefined;
  plugins: string[];
  themes: string[];
  mappings: Record<string, string>;
} {
  const development = config.env?.development ?? {};
  return {
    phpVersion: process.env.WP_ENV_PHP_VERSION ?? stringValue(development.phpVersion) ?? stringValue(config.phpVersion),
    core: process.env.WP_ENV_CORE ?? stringValue(development.core) ?? stringValue(config.core),
    plugins: stringArray(development.plugins) ?? stringArray(config.plugins) ?? [],
    themes: stringArray(development.themes) ?? stringArray(config.themes) ?? [],
    mappings: { ...(recordStrings(config.mappings) ?? {}), ...(recordStrings(development.mappings) ?? {}) },
  };
}

export function effectiveWpEnvPort(config: ThemeWpEnvConfig, environment: NodeJS.ProcessEnv = process.env): number {
  const development = config.env?.development ?? {};
  if (config.autoPort === true) throw new Error('Theme proof cannot safely target wp-env while autoPort may change the runtime URL.');
  const raw = environment.WP_ENV_PORT ?? development.port ?? config.port ?? 8888;
  const port = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid effective wp-env development port: ${String(raw)}.`);
  }
  return port;
}

export function effectiveWpEnvUrl(config: ThemeWpEnvConfig, environment: NodeJS.ProcessEnv = process.env): string {
  const port = effectiveWpEnvPort(config, environment);
  const development = config.env?.development ?? {};
  const developmentConfig = isPlainRecord(development.config) ? development.config : {};
  const rootConfig = isPlainRecord(config.config) ? config.config : {};
  const home = developmentConfig.WP_HOME ?? rootConfig.WP_HOME;
  if (home === undefined) return `http://localhost:${port}`;
  if (typeof home !== 'string') throw new Error('Theme proof requires a string wp-env development WP_HOME.');
  let url: URL;
  try { url = new URL(home); } catch { throw new Error('Theme proof could not parse the wp-env development WP_HOME URL.'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Theme proof requires wp-env WP_HOME to use a local HTTP host.');
  }
  if (!url.port) url.port = String(port);
  return url.toString().replace(/\/$/, '');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function themePreflightFailure(theme: PreparedThemeProof, config: ThemeWpEnvConfig): string | undefined {
  try { effectiveWpEnvUrl(config); } catch (error) { return error instanceof Error ? error.message : String(error); }
  const effective = effectiveWpEnvConfig(config);
  if (!effective.phpVersion || !/^\d+\.\d+(?:\.\d+)?$/.test(effective.phpVersion)) {
    return 'Theme proof needs a specified development PHP version in --wp-env-config (phpVersion or env.development.phpVersion).';
  }
  if (theme.requiresPhp && compareVersion(effective.phpVersion, theme.requiresPhp) < 0) {
    return `Theme requires PHP ${theme.requiresPhp}, but the effective wp-env development PHP version is ${effective.phpVersion}.`;
  }
  if (effective.core !== 'WordPress/WordPress#7.1') {
    return `Theme proof requires WordPress/WordPress#7.1; effective development core is ${effective.core ?? 'unspecified'}.`;
  }
  if (effective.plugins.some((source) => !isLocalSource(source))) {
    return 'Theme proof accepts local dependency plugins only; remove remote plugin sources from --wp-env-config.';
  }
  return undefined;
}

export async function writeThemeRuntimeConfig(
  sourceConfig: ThemeWpEnvConfig,
  _sourceConfigPath: string,
  prepared: PreparedThemeProof,
  stagedTheme: string,
  outputPath: string,
): Promise<void> {
  const effective = effectiveWpEnvConfig(sourceConfig);
  const config: ThemeWpEnvConfig = structuredClone(sourceConfig);
  config.themes = [...effective.themes.map((source) => resolveLocalSource(source, process.cwd())), stagedTheme];
  config.phpVersion = effective.phpVersion;
  config.core = effective.core;
  config.mappings = {
    ...Object.fromEntries(Object.entries(effective.mappings).map(([destination, source]) => [
      destination,
      resolveLocalSource(source, process.cwd()),
    ])),
  };
  if (config.env?.development) {
    config.env.development = {
      ...config.env.development,
      phpVersion: effective.phpVersion,
      core: effective.core,
      plugins: effective.plugins.map((source) => resolveLocalSource(source, process.cwd())),
      themes: config.themes,
      mappings: config.mappings,
    };
  } else {
    config.plugins = effective.plugins.map((source) => resolveLocalSource(source, process.cwd()));
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function copyThemeSnapshot(prepared: PreparedThemeProof, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(prepared.root, destination, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.git',
  });
  const copied = await listThemeFiles(destination);
  if (copied.length !== prepared.manifest.files.length) throw new Error('The staged theme tree differs from its pinned source file inventory.');
  for (const file of prepared.manifest.files) {
    const bytes = await readFile(path.join(destination, file.file));
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.byteLength !== file.bytes || hash !== file.sha256) throw new Error(`The staged theme bytes differ from the pinned source: ${file.file}`);
  }
}

export async function pinLocalPluginDirectories(plugins: readonly string[], baseDirectory: string, evidence: EvidenceStore): Promise<unknown[]> {
  const result = [];
  for (const source of plugins) {
    const directory = resolveLocalSource(source, baseDirectory);
    const manifest = [];
    const stats = await lstat(directory);
    const files = stats.isFile() ? [path.basename(directory)] : await listThemeFiles(directory);
    for (const file of files) {
      const bytes = await readFile(stats.isFile() ? directory : path.join(directory, file));
      const reference = await evidence.put(bytes, { mediaType: 'application/octet-stream' });
      manifest.push({ file, sha256: reference.sha256, bytes: reference.bytes });
    }
    const manifestBytes = Buffer.from(JSON.stringify({ files: manifest }), 'utf8');
    const snapshot = await evidence.put(manifestBytes, { mediaType: 'application/json' });
    result.push({ localPath: directory, ...snapshot });
  }
  return result;
}

async function listThemeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const fullPath = path.join(directory, entry.name);
      const stats = await lstat(fullPath);
      if (stats.isSymbolicLink()) throw new Error(`Theme proof cannot snapshot symlinked input: ${path.relative(root, fullPath)}`);
      if (stats.isDirectory()) await visit(fullPath);
      else if (stats.isFile()) files.push(path.relative(root, fullPath).split(path.sep).join('/'));
    }
  };
  await visit(root);
  return files.sort();
}

function jsonObjectEnd(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index++) {
    const character = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

function topLevelPropertyRange(object: string, key: string, expected: string): [number, number] | undefined {
  try {
    if ((JSON.parse(object) as Record<string, unknown>)[key] !== expected) return undefined;
  } catch {
    return undefined;
  }
  const keyToken = JSON.stringify(key);
  let cursor = 1;
  while (cursor < object.length - 1) {
    while (/[\s,]/.test(object[cursor] ?? '')) cursor++;
    const keyStart = cursor;
    if (object[cursor] !== '"') return undefined;
    cursor = stringEnd(object, cursor);
    if (cursor < 0) return undefined;
    const currentKey = object.slice(keyStart, cursor);
    while (/\s/.test(object[cursor] ?? '')) cursor++;
    if (object[cursor] !== ':') return undefined;
    cursor++;
    while (/\s/.test(object[cursor] ?? '')) cursor++;
    const valueStart = cursor;
    cursor = jsonValueEnd(object, cursor);
    if (cursor < 0) return undefined;
    if (currentKey === keyToken) {
      if (valueStart === 1) return undefined;
      let removeStart = keyStart;
      let removeEnd = cursor;
      let before = keyStart - 1;
      while (before > 0 && /\s/.test(object[before] ?? '')) before--;
      if (object[before] === ',') removeStart = before;
      else {
        let after = cursor;
        while (/\s/.test(object[after] ?? '')) after++;
        if (object[after] === ',') removeEnd = after + 1;
      }
      return [removeStart, removeEnd];
    }
    cursor++;
  }
  return undefined;
}

function stringEnd(value: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index++) {
    if (escaped) escaped = false;
    else if (value[index] === '\\') escaped = true;
    else if (value[index] === '"') return index + 1;
  }
  return -1;
}

function jsonValueEnd(value: string, start: number): number {
  if (value[start] === '"') return stringEnd(value, start);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index++) {
    const character = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      if (depth === 0) return index;
      depth--;
    } else if (character === ',' && depth === 0) return index;
  }
  return value.length - 1;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function recordStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string') ? Object.fromEntries(entries) : undefined;
}

function compareVersion(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function isLocalSource(value: string): boolean {
  return value.startsWith('.') || value.startsWith('~') || path.isAbsolute(value);
}

export function resolveLocalSource(value: string, baseDirectory: string): string {
  if (value.startsWith('~/')) return path.resolve(homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(baseDirectory, value);
}
