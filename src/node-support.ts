/** The Node.js releases supported by the resolved production dependency graph. */
export const SUPPORTED_NODE_RANGE = '^20.19.0 || ^22.13.0 || >=24.0.0';

/**
 * Test a Node version without pulling a semver dependency into the runtime bootstrap.
 *
 * The supported set intentionally excludes the non-LTS 21.x and 23.x lines: jsdom's
 * resolved production graph supports the 20, 22, and 24+ lines only.
 */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major >= 24;
}

/** Fail before the CLI or library can report an unsupported runtime as successful. */
export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`block-runner requires Node.js ${SUPPORTED_NODE_RANGE}; found v${version}.`);
  }
}
