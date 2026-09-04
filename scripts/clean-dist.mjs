import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This script accepts no target argument: it can only move this checkout's build output.
if (process.argv.length > 2) throw new Error('clean-dist accepts no arguments.');
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(projectRoot, 'dist');
try {
  await lstat(target);
} catch (error) {
  if (error.code === 'ENOENT') process.exit(0);
  throw error;
}

const result = spawnSync('trash', [target], { encoding: 'utf8' });
if (!result.error && result.status === 0) {
  console.log('Moved previous dist to Trash.');
} else {
  // Hosts without the macOS CLI still retain the output in the user's Trash directory.
  // A failed rename fails the build rather than falling back to permanent deletion.
  const trashDirectory = path.join(homedir(), '.Trash');
  await mkdir(trashDirectory, { recursive: true });
  const destination = path.join(trashDirectory, `block-runner-dist-${randomUUID()}`);
  await rename(target, destination);
  console.log(`Moved previous dist to ${destination}`);
}
