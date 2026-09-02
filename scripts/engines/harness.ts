import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Model engines receive the entire task through stdin. Keep them outside the repository and
 * remove write-capable tooling so a benchmark cell cannot mutate the checkout it measures.
 */
export const MODEL_WORKDIR = path.join(tmpdir(), 'block-runner-model-harness', String(process.pid));
mkdirSync(MODEL_WORKDIR, { recursive: true });

export function codexExecArgs(model: string, effort: string): string[] {
  return [
    'exec',
    '-m', model,
    '-c', `model_reasoning_effort=${effort}`,
    '--sandbox', 'read-only',
    '--cd', MODEL_WORKDIR,
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '-',
  ];
}

export function claudePrintArgs(model: string, effort: string): string[] {
  return [
    '-p',
    '--model', model,
    '--effort', effort,
    '--safe-mode',
    '--restricted',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
  ];
}
