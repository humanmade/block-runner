import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('accepts the current patch version in a real skill-validation release receipt', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'block-runner-release-receipt-test-'));
  const receiptPath = path.join(directory, 'receipt.json');
  const result = spawnSync(process.execPath, [
    'scripts/release-check.mjs', '--matrix', 'skill-validate', '--receipt', receiptPath,
  ], { encoding: 'utf8', timeout: 30_000 });
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(result.status, result.stderr).toBe(0);
  expect(receipt.status, receipt.measurement?.engineError).toBe('passed');
  expect(receipt.candidate.packageVersion).toBe(pkg.version);
}, 35_000);
