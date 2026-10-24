/** The Node.js releases supported by the resolved production dependency graph. */
export const SUPPORTED_NODE_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1';

/**
 * Test a Node version without pulling a semver dependency into the runtime bootstrap.
 *
 * Require the security-patched floors of supported Node release lines.
 * Node 20, 21, 23 and 25 are no longer supported.
 */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const atLeast = (minMinor: number, minPatch: number) => minor > minMinor || (minor === minMinor && patch >= minPatch);
  return (major === 22 && atLeast(23, 4))
    || (major === 24 && atLeast(22, 1))
    || (major === 26 && atLeast(12, 1))
    || major > 26;
}

/** Fail before the CLI or library can report an unsupported runtime as successful. */
export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`block-runner requires Node.js ${SUPPORTED_NODE_RANGE}; found v${version}.`);
  }
}
