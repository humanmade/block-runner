import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  files: string[];
};
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { version?: string; integrity?: string }>;
};
const pins = JSON.parse(readFileSync(new URL('../proof/dependency-pins.json', import.meta.url), 'utf8')) as {
  schemaVersion: number;
  packages: Record<string, { version?: string; integrity?: string }>;
};

const proofTooling = {
  '@wordpress/env': '11.12.0',
  '@playwright/test': '1.61.1',
  '@wordpress/e2e-test-utils-playwright': '1.51.0',
  'axe-core': '4.11.0',
  pixelmatch: '7.1.0',
  pngjs: '7.0.0',
} as const;

describe('proof packaging boundary', () => {
  it('keeps browser and real-WordPress tooling out of the basic production install', () => {
    expect(packageJson).not.toHaveProperty('optionalDependencies');
    for (const [name, version] of Object.entries(proofTooling)) {
      expect(packageJson.dependencies[name]).toBeUndefined();
      expect(packageJson.devDependencies[name]).toBe(version);
      expect(packageJson.peerDependencies[name]).toBe(version);
      expect(packageJson.peerDependenciesMeta[name]).toEqual({ optional: true });
    }
  });

  it('ships the small integrity-pin snapshot that packed proof receipts need', () => {
    expect(packageJson.files).toContain('proof/dependency-pins.json');
    expect(pins.schemaVersion).toBe(1);
    const directWordPressPackages = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
      .filter((name) => name.startsWith('@wordpress/'));
    for (const name of directWordPressPackages) {
      const rootPin = lock.packages[`node_modules/${name}`];
      expect(rootPin, `missing root lock pin for ${name}`).toBeDefined();
      expect(pins.packages[`node_modules/${name}`]).toEqual({
        version: rootPin?.version,
        integrity: rootPin?.integrity,
      });
    }
  });
});
