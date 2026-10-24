import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('boots without reading host storage and restores the caller getter', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    let reads = 0;
    const getter = () => { reads++; throw new Error('Host storage must not be read'); };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: getter });
    const { bootHeadlessWordPressSync } = await import('./src/headless/env.ts');
    const wp = bootHeadlessWordPressSync();
    assert.ok(wp.getBlockType('core/paragraph'));
    assert.equal(reads, 0);
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, 'localStorage').get, getter);
  `], { encoding: 'utf8', timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
}, 35_000);
