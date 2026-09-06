export interface ProofControlStartupOptions<T> {
  root: string;
  start: () => T | Promise<T>;
}

export function startWithPreparedStageMount<T>(options: ProofControlStartupOptions<T>): Promise<Awaited<T>>;
