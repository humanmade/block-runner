/**
 * Drop unused Gutenberg media WASM from the install tree.
 *
 * Headless convert/validate never calls @wordpress/upload-media's image
 * pipeline; @wordpress/vips is only loaded via dynamic import() when that
 * pipeline runs. The packages are still installed as transitive deps and
 * add ~155MB. Overrides in this package.json replace them when block-runner
 * is the install root; this script also prunes them when block-runner is a
 * nested dependency (npm ignores nested overrides).
 *
 * Never fails the install — best-effort only.
 */
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {string[]} */
const targets = [
  // block-runner is the install root
  join(pkgRoot, 'node_modules', '@wordpress', 'vips'),
  join(pkgRoot, 'node_modules', 'wasm-vips'),
  // block-runner lives at node_modules/block-runner (hoisted deps one level up)
  join(pkgRoot, '..', '@wordpress', 'vips'),
  join(pkgRoot, '..', 'wasm-vips'),
  // nested under block-runner's own node_modules (no hoist)
  join(pkgRoot, 'node_modules', '@wordpress', 'vips'),
  join(pkgRoot, 'node_modules', 'wasm-vips'),
];

const seen = new Set();
for (const target of targets) {
  if (seen.has(target) || !existsSync(target)) continue;
  seen.add(target);
  try {
    // Only remove real packages / symlinks that look like the heavy ones.
    const stat = lstatSync(target);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Ignore EPERM / ENOENT / pnpm store protections.
  }
}
