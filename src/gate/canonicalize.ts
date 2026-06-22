import { getWp } from '../headless/wp.js';
import { BlockRunnerReport, CanonicalizeOptions } from '../types.js';
import { validate } from './validate.js';

export async function canonicalize(markup: string, options: CanonicalizeOptions = {}): Promise<BlockRunnerReport> {
  const wp = await getWp();
  const output = wp.serialize(wp.parse(markup, { __unstableSkipMigrationLogs: true }));
  const report = await validate(output, options);

  return {
    ...report,
    ok: report.summary.invalid === 0,
    command: 'fix',
    output,
  };
}
