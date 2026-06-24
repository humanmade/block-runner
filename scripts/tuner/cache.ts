/**
 * The propose/realize cache — the apparatus that makes the inner loop free.
 *
 * The cost insight (md/13): in any engine exactly one step is slow + non-deterministic
 * (the LLM call). Everything after it is instant + deterministic. So we cache the costly
 * artifact (the *propose* result — raw markup for a monolithic engine, or `propose().raw`
 * for a split engine) keyed by everything that could change it, and replay the deterministic
 * tail (*realize*) over the cached artifact for free.
 *
 * Cache key = sha(engineLabel + model + effort + inputHtml + promptHash). A fixture edit
 * changes inputHtml; a prompt/schema edit changes promptHash — either invalidates the entry,
 * so a stale artifact is never replayed silently (T0 reports it as `stale`/`uncached`).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EVAL_DIR } from './score.js';

export const CACHE_DIR = path.join(EVAL_DIR, '.cache');

export interface CacheKeyParts {
  engineLabel: string;
  model: string;
  effort: string;
  inputHtml: string;
  promptHash: string;
}

export interface CacheEntry {
  // Provenance, so a cache file is self-describing and inspectable.
  engineLabel: string;
  model: string;
  effort: string;
  label: string; // producer/layout
  promptHash: string;
  // The costly artifact: a split engine's propose().raw, or a monolithic engine's
  // convert().output. realize() / validate() is replayed over this.
  raw: string;
  // Wall-clock of the propose (model) call when this artifact was produced — the number a
  // speed goal targets (it's ~all of a run's wall-clock; realize is milliseconds).
  proposeMs?: number;
  cachedAt: string;
}

export function cacheKey(parts: CacheKeyParts): string {
  const h = createHash('sha256');
  h.update(parts.engineLabel);
  h.update('\0');
  h.update(parts.model);
  h.update('\0');
  h.update(parts.effort);
  h.update('\0');
  h.update(parts.inputHtml);
  h.update('\0');
  h.update(parts.promptHash);
  return h.digest('hex').slice(0, 16);
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

// Read a cached artifact for these key parts; undefined means uncached/stale (a
// promptHash or inputHtml change moves the key, so a stale entry simply misses).
export function readCache(parts: CacheKeyParts): CacheEntry | undefined {
  const file = cachePath(cacheKey(parts));
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CacheEntry;
  } catch {
    return undefined;
  }
}

export function writeCache(parts: CacheKeyParts, label: string, raw: string, proposeMs?: number): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const entry: CacheEntry = {
    engineLabel: parts.engineLabel,
    model: parts.model,
    effort: parts.effort,
    label,
    promptHash: parts.promptHash,
    raw,
    proposeMs,
    cachedAt: new Date().toISOString(),
  };
  writeFileSync(cachePath(cacheKey(parts)), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
}
