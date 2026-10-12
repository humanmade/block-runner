/** The Node.js releases supported by the resolved production dependency graph. */
export const SUPPORTED_NODE_RANGE = '^22.13.0 || >=24.0.0';

/**
 * Test a Node version without pulling a semver dependency into the runtime bootstrap.
 *
 * The supported set intentionally excludes Node 20, 21, and 23: Wesper 0.5.0
 * requires Node 22.12+, while the resolved production graph supports Node 22 and 24+.
 */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 13) || major >= 24;
}

/** Fail before the CLI or library can report an unsupported runtime as successful. */
export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`block-runner requires Node.js ${SUPPORTED_NODE_RANGE}; found v${version}.`);
  }
}
