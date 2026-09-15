export type WordPressEnvironmentStatus = {
  stdout: string;
  stderr: string;
};

export type WordPressEnvironmentCommand = (args: readonly string[]) => Promise<WordPressEnvironmentStatus>;

/**
 * Keep a sequential proof suite on one wp-env lifecycle without stopping an
 * environment that was already running before the suite began.
 */
export function createWordPressProofLifecycle(command: WordPressEnvironmentCommand): {
  prepare(): Promise<void>;
  cleanup(): Promise<void>;
} {
  let startedHere = false;

  return {
    async prepare() {
      const status = await command(['status', '--json']);
      let parsed: unknown;
      try {
        parsed = JSON.parse(status.stdout);
      } catch {
        throw new Error('wp-env status did not return JSON; refusing to claim lifecycle ownership.');
      }
      if (!parsed || typeof parsed !== 'object' || !('status' in parsed)) {
        throw new Error('wp-env status did not return a runtime status; refusing to claim lifecycle ownership.');
      }
      const runtimeStatus = parsed.status;
      if (runtimeStatus === 'running') return;
      if (runtimeStatus === 'uninitialized' || runtimeStatus === 'stopped') {
        startedHere = true;
        return;
      }
      throw new Error(`Unknown wp-env runtime status: ${String(runtimeStatus)}; refusing to claim lifecycle ownership.`);
    },
    async cleanup() {
      if (startedHere) await command(['stop']);
    },
  };
}
