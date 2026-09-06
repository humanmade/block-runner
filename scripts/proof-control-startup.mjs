import { constants as fsConstants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Prepare the host-owned wp-env bind mount before asking Docker to start.
 * Keeping the prerequisite and start request together prevents a fresh Linux
 * Docker mount from creating a root-owned directory for the host user.
 */
export async function startWithPreparedStageMount({ root, start }) {
  const directory = path.join(root, '.block-runner-proof-stage');
  await mkdir(directory, { recursive: true });
  await access(directory, fsConstants.W_OK);
  return start();
}
